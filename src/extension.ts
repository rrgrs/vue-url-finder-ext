import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { glob } from 'glob';
import { AST_NODE_TYPES, TSESTree } from '@typescript-eslint/types';
import { parse } from '@typescript-eslint/typescript-estree';

const VUE_FILE_GLOB_PATTERN = '**/*.vue';
const ROUTER_FILENAME = 'router.ts';

interface RouteInfo {
    fullPath: string; // Stores the fully constructed URL path
    componentFilename: string; // Just the filename e.g., "LandingPage.vue"
}

type ImporterMap = Map<string, Set<string>>;

async function findAllRouterFiles(workspaceRoot: string): Promise<string[]> {
    console.log(`Searching for '${ROUTER_FILENAME}' in ${workspaceRoot}`);
    const routerFiles = await glob(`**/${ROUTER_FILENAME}`, {
        cwd: workspaceRoot,
        nodir: true,
        absolute: true,
        ignore: '**/node_modules/**',
    });
    console.log(`Found router files: ${routerFiles.join(', ')}`);
    return routerFiles;
}

function getLiteralValue(node: TSESTree.Node | null | undefined): string | number | boolean | null | undefined {
    if (node?.type === AST_NODE_TYPES.Literal) {
        if (typeof node.value === 'string' || typeof node.value === 'number' || typeof node.value === 'boolean' || node.value === null) {
            return node.value;
        }
        return undefined;
    }
    return undefined;
}

function getComponentFilenameFromNode(componentNode: TSESTree.Expression | TSESTree.PrivateIdentifier | undefined, variableToFilenameMap: Map<string, string>): string | null {
    if (!componentNode) return null;

    // Case 1: component: Identifier (e.g., component: Admin)
    if (componentNode.type === AST_NODE_TYPES.Identifier) {
        return variableToFilenameMap.get(componentNode.name) ?? null;
    }

    // Case 2: component: () => import('./path/File.vue')
    if (componentNode.type === AST_NODE_TYPES.ArrowFunctionExpression && componentNode.body.type === AST_NODE_TYPES.ImportExpression) {
        const importSource = componentNode.body.source;
        if (importSource.type === AST_NODE_TYPES.Literal && typeof importSource.value === 'string' && importSource.value.endsWith('.vue')) {
            return path.basename(importSource.value);
        }
    }

     // Case 3: Could potentially be defineAsyncComponent, etc. (Add more checks if needed)
     // Example for defineAsyncComponent(() => import(...))
     if (componentNode.type === AST_NODE_TYPES.CallExpression && componentNode.callee.type === AST_NODE_TYPES.Identifier && componentNode.callee.name === 'defineAsyncComponent' && componentNode.arguments.length > 0) {
         const arg = componentNode.arguments[0];
          if (arg.type === AST_NODE_TYPES.ArrowFunctionExpression && arg.body.type === AST_NODE_TYPES.ImportExpression) {
             const importSource = arg.body.source;
             if (importSource.type === AST_NODE_TYPES.Literal && typeof importSource.value === 'string' && importSource.value.endsWith('.vue')) {
                 return path.basename(importSource.value);
             }
         }
     }


    console.warn(`[AST] Unsupported component definition type: ${componentNode.type}`);
    return null;
}


function processRoutesAst(
    routesArrayNode: TSESTree.ArrayExpression,
    variableToFilenameMap: Map<string, string>,
    parentPath: string, // Accumulate parent path segments
    routerFilePath: string // For logging/debugging
): RouteInfo[] {
    const extractedRoutes: RouteInfo[] = [];

    for (const element of routesArrayNode.elements) {
        if (element?.type !== AST_NODE_TYPES.ObjectExpression) {
            // console.warn(`[AST ${path.basename(routerFilePath)}] Skipping non-object element in routes array:`, element?.type);
            continue; // Skip nulls or non-objects in the array
        }

        const routeObjectNode = element;
        let currentSegment: string | null = null;
        let componentFilename: string | null = null;
        let childrenNode: TSESTree.ArrayExpression | null = null;

        // Find path, component, and children properties within this route object
        for (const property of routeObjectNode.properties) {
            if (property.type !== AST_NODE_TYPES.Property || property.key.type !== AST_NODE_TYPES.Identifier) {
                continue; // Skip spread elements or non-identifier keys
            }

            const keyName = property.key.name;
            const valueNode = property.value;

            if (keyName === 'path') {
                const pathValue = getLiteralValue(valueNode);
                if (typeof pathValue === 'string') {
                    currentSegment = pathValue;
                } else {
                     console.warn(`[AST ${path.basename(routerFilePath)}] Non-string literal found for 'path':`, valueNode.type);
                }
            } else if (keyName === 'component') {
                if (valueNode.type === AST_NODE_TYPES.Identifier || valueNode.type === AST_NODE_TYPES.ArrowFunctionExpression || valueNode.type === AST_NODE_TYPES.CallExpression) {
                    componentFilename = getComponentFilenameFromNode(valueNode, variableToFilenameMap);
                }
                 if (!componentFilename) {
                     // Optional: Log if component wasn't resolvable
                     // console.warn(`[AST ${path.basename(routerFilePath)}] Could not resolve component filename for path segment '${currentSegment}'. Node type: ${valueNode.type}`);
                 }
            } else if (keyName === 'children' && valueNode.type === AST_NODE_TYPES.ArrayExpression) {
                childrenNode = valueNode;
            }
        }

        // --- Process the found route ---
        if (currentSegment !== null && componentFilename !== null) {
             // Construct full path using POSIX path join for URLs
             // Handle joining logic carefully
             let fullPath: string;
             if (!currentSegment) { // Empty path segment means use parent path
                fullPath = parentPath || '/'; // Default to root if parent also empty
             } else if (currentSegment.startsWith('/')) { // Absolute path segment overrides parent
                 fullPath = currentSegment;
             } else if (!parentPath || parentPath === '/') { // Parent is root
                 fullPath = '/' + currentSegment;
             } else { // Normal join
                 fullPath = parentPath.replace(/\/$/, '') + '/' + currentSegment; // Ensure single slash
             }
             // Normalize just in case (remove double slashes etc.)
             fullPath = path.posix.normalize(fullPath);

            console.log(`[AST ${path.basename(routerFilePath)}] Found Route: FullPath='${fullPath}', Component='${componentFilename}'`);
            extractedRoutes.push({ fullPath, componentFilename });
        } else if (currentSegment !== null && componentFilename === null) {
             // Log routes with paths but no resolvable component if desired for debugging
            // console.log(`[AST ${path.basename(routerFilePath)}] Found route with path '${currentSegment}' but no resolvable component filename.`);
        }

        // --- Process Children Recursively ---
        if (childrenNode) {
            // Construct the new parent path for children
             let childParentPath: string;
             if (!currentSegment) { // Parent path for children of '' is same as current parent
                 childParentPath = parentPath;
             } else if (currentSegment.startsWith('/')) { // Absolute path resets hierarchy
                 childParentPath = currentSegment;
             } else if (!parentPath || parentPath === '/') { // Parent is root
                 childParentPath = '/' + currentSegment;
             } else { // Normal join
                 childParentPath = parentPath.replace(/\/$/, '') + '/' + currentSegment;
             }
             childParentPath = path.posix.normalize(childParentPath); // Normalize before passing down

            const childRoutes = processRoutesAst(childrenNode, variableToFilenameMap, childParentPath, routerFilePath);
            extractedRoutes.push(...childRoutes); // Add routes found in children
        }
    }

    return extractedRoutes;
}

async function parseRouterFileAst(routerFilePath: string): Promise<RouteInfo[]> {
    console.log(`[AST] Parsing router file: ${routerFilePath}`);
    try {
        const fileContent = await fs.readFile(routerFilePath, 'utf-8');
        // Enable JSX parsing in case it's used within templates, although less common in router files
        const ast = parse(fileContent, { jsx: true, loc: false, range: false, errorOnUnknownASTType: false, useJSXTextNode: false });

        const variableToFilenameMap = new Map<string, string>();
        let routesArrayNode: TSESTree.ArrayExpression | null = null;
        let routerVariableName: string | null = null; // Track the variable name if router is assigned first

        // --- Traverse AST ---
        for (const node of ast.body) {
            // 1. Find Imports (same as before)
            if (node.type === AST_NODE_TYPES.ImportDeclaration && node.source.type === AST_NODE_TYPES.Literal && typeof node.source.value === 'string' && node.source.value.endsWith('.vue')) {
                if (node.specifiers.length > 0 && node.specifiers[0].type === AST_NODE_TYPES.ImportDefaultSpecifier) {
                    const variableName = node.specifiers[0].local.name;
                    const filename = path.basename(node.source.value);
                    variableToFilenameMap.set(variableName, filename);
                }
            }

            // 2. Find 'const router = createRouter({ ... routes: [...] })'
            if (node.type === AST_NODE_TYPES.VariableDeclaration) {
                for (const declaration of node.declarations) {
                    if (declaration.id.type === AST_NODE_TYPES.Identifier && declaration.init?.type === AST_NODE_TYPES.CallExpression) {
                        const callExpr = declaration.init;
                        // Check if it's likely createRouter call (can be improved by checking callee name)
                        if (callExpr.arguments.length > 0 && callExpr.arguments[0].type === AST_NODE_TYPES.ObjectExpression) {
                            const configObject = callExpr.arguments[0];
                            const routesProp = configObject.properties.find(p =>
                                p.type === AST_NODE_TYPES.Property &&
                                p.key.type === AST_NODE_TYPES.Identifier &&
                                p.key.name === 'routes' &&
                                p.value.type === AST_NODE_TYPES.ArrayExpression
                            ) as TSESTree.Property | undefined; // Type assertion

                            if (routesProp) {
                                routesArrayNode = routesProp.value as TSESTree.ArrayExpression; // Store the routes node
                                routerVariableName = declaration.id.name; // Store the variable name ('router')
                                console.log(`[AST ${path.basename(routerFilePath)}] Found 'routes' array assigned to variable '${routerVariableName}'.`);
                                // Don't break yet, need to check export later
                            }
                        }
                    }
                }
            }

            // 3. Find 'export default createRouter({ ... routes: [...] })' (Original Check)
            if (node.type === AST_NODE_TYPES.ExportDefaultDeclaration) {
                // Check if exporting a direct call expression
                if (node.declaration.type === AST_NODE_TYPES.CallExpression &&
                    node.declaration.arguments.length > 0 &&
                    node.declaration.arguments[0].type === AST_NODE_TYPES.ObjectExpression)
                {
                    const configObject = node.declaration.arguments[0];
                    const routesProp = configObject.properties.find(p =>
                        p.type === AST_NODE_TYPES.Property &&
                        p.key.type === AST_NODE_TYPES.Identifier &&
                        p.key.name === 'routes' &&
                        p.value.type === AST_NODE_TYPES.ArrayExpression
                    ) as TSESTree.Property | undefined;

                    if (routesProp) {
                        routesArrayNode = routesProp.value as TSESTree.ArrayExpression;
                        console.log(`[AST ${path.basename(routerFilePath)}] Found 'routes' array in direct export default.`);
                        break; // Found it directly exported
                    }
                }
                // Check if exporting the variable we tracked earlier
                else if (routerVariableName && node.declaration.type === AST_NODE_TYPES.Identifier && node.declaration.name === routerVariableName) {
                    console.log(`[AST ${path.basename(routerFilePath)}] Confirmed export of variable '${routerVariableName}' which contains routes.`);
                    // We already stored routesArrayNode when finding the variable, so we can break.
                     break;
                }
            }
        } // End AST body loop

        console.log(`[AST ${path.basename(routerFilePath)}] Variable Map:`, variableToFilenameMap);

        // 4. Process the routes array if found (either directly or via variable)
        if (routesArrayNode) {
            return processRoutesAst(routesArrayNode, variableToFilenameMap, '', routerFilePath);
        } else {
            console.warn(`[AST ${path.basename(routerFilePath)}] Could not find 'routes' array in any expected structure.`);
            return [];
        }

    } catch (err) {
        if (err instanceof Error) {
            console.error(`[AST] Error parsing ${routerFilePath}: ${err.message}`, err.stack);
            vscode.window.showErrorMessage(`Failed to parse router file ${path.basename(routerFilePath)}. Check console for details.`);
        } else {
            console.error(`[AST] Unknown error parsing ${routerFilePath}: ${String(err)}`);
        }
        return [];
    }
}


async function parseAllRoutersAst(routerFilePaths: string[]): Promise<RouteInfo[]> {
    let allRoutes: RouteInfo[] = [];
    for (const filePath of routerFilePaths) {
        const routesFromFile = await parseRouterFileAst(filePath);
        allRoutes = allRoutes.concat(routesFromFile);
    }
    console.log(`[AST] Total routes extracted from all router files: ${allRoutes.length}`);

     // --- Deduplication (Optional but recommended) ---
     const uniqueRoutes = Array.from(new Map(allRoutes.map(r => [`${r.fullPath}::${r.componentFilename}`, r])).values());
     console.log(`[AST] Unique routes found: ${uniqueRoutes.length}`);

    return uniqueRoutes;
}


async function buildImporterMapAst(workspaceRoot: string): Promise<ImporterMap> {
    console.log("[AST] Building importer map...");
    const importerMap: ImporterMap = new Map();
    const vueFiles = await glob(VUE_FILE_GLOB_PATTERN, {
        cwd: workspaceRoot, nodir: true, absolute: true, ignore: '**/node_modules/**'
    });
    console.log(`[AST] Found ${vueFiles.length} Vue files to scan for imports.`);

    let scannedCount = 0;
    for (const importerFilePath of vueFiles) {
        const importerFilename = path.basename(importerFilePath);
        try {
            const content = await fs.readFile(importerFilePath, 'utf-8');

            // Basic check for <script> tags - a full SFC parser (@vue/compiler-sfc) is better
            const scriptContentMatch = content.match(/<script(?: setup)?(?:\s+lang=["']ts["'])?>([\s\S]*?)<\/script>/);
            if (!scriptContentMatch || !scriptContentMatch[1]) {
                // console.log(`[AST Importer] No script tag found in ${importerFilename}`);
                continue; // Skip files without script tags
            }
            const scriptContent = scriptContentMatch[1];

            // Parse the script content
            const ast = parse(scriptContent, { jsx: false, loc: false, range: false, errorOnUnknownASTType: false, useJSXTextNode: false });

            // Traverse the AST to find imports
            for (const node of ast.body) {
                if (node.type === AST_NODE_TYPES.ImportDeclaration && node.source.type === AST_NODE_TYPES.Literal && typeof node.source.value === 'string') {
                     const importSource = node.source.value;
                     // Check if it looks like a component import (ends in .vue)
                     // This check might need refinement based on project conventions
                     if (importSource.endsWith('.vue')) {
                         const importedFilename = path.basename(importSource);
                         if (importedFilename) {
                             if (!importerMap.has(importedFilename)) {
                                 importerMap.set(importedFilename, new Set());
                             }
                             importerMap.get(importedFilename)?.add(importerFilename);
                         }
                     }
                }
                 // TODO: Add checks for defineAsyncComponent, require, etc. if necessary
            }
            scannedCount++;
            if (scannedCount % 100 === 0) console.log(`[AST Importer] Scanned ${scannedCount} files...`);

        } catch (err) {
            // Log parsing errors for script blocks but continue
            if (err instanceof Error) {
                 console.warn(`[AST Importer] Could not read or parse script in ${importerFilePath}: ${err.message}`);
            } else {
                 console.warn(`[AST Importer] Could not read or parse script in ${importerFilePath}: ${String(err)}`);
            }
        }
    }
    console.log(`[AST] Importer map built. Found importers for ${importerMap.size} components.`);
    return importerMap;
}

async function findUrlsViaImports(
    filenameToCheck: string,
    routeMap: Map<string, string[]>, // Now ComponentFilename -> [Full URL paths]
    importerMap: ImporterMap,
    visited: Set<string>
): Promise<string[]> {

    const foundUrls = new Set<string>();
    if (visited.has(filenameToCheck)) {
        // console.log(`[Import Chain] Cycle detected or already visited: ${filenameToCheck}`);
        return [];
    }
    visited.add(filenameToCheck);
    // console.log(`[Import Chain] Checking: ${filenameToCheck}`);

    // Base Case 1: Check if the current component is directly used in a route
    if (routeMap.has(filenameToCheck)) {
        const directUrls = routeMap.get(filenameToCheck) || [];
        directUrls.forEach(url => foundUrls.add(url));
        console.log(`[Import Chain] Found direct route(s) for ${filenameToCheck}: ${directUrls.join(', ')}`);
    }

    // Recursive Step: Find components that import the current one ("parents")
    const parentFilenames = importerMap.get(filenameToCheck) || new Set();

    if (parentFilenames.size > 0) {
        // console.log(`[Import Chain] Found parents for ${filenameToCheck}: ${Array.from(parentFilenames).join(', ')}`);
        const parentResults = await Promise.all(
            Array.from(parentFilenames).map(parentFilename =>
                // IMPORTANT: Pass a *copy* of visited for each branch
                findUrlsViaImports(parentFilename, routeMap, importerMap, new Set(visited))
            )
        );
        parentResults.forEach(urlsFromParent => {
            urlsFromParent.forEach(url => foundUrls.add(url));
        });
    }
    // else {
    //     console.log(`[Import Chain] No parents found importing ${filenameToCheck}. End of this branch.`);
    // }

    return Array.from(foundUrls);
}


export function activate(context: vscode.ExtensionContext) {
    console.log('Extension "vue-url-finder" (AST) is now active!');

    let routeMapPromise: Promise<Map<string, string[]>> | null = null;
    let importerMapPromise: Promise<ImporterMap> | null = null;

    // Function to compute/cache maps
    async function ensureMapsComputed(workspaceRoot: string): Promise<{routeMap: Map<string, string[]>, importerMap: ImporterMap}> {
        if (!routeMapPromise) {
             console.log("Initiating router file parsing...");
             routeMapPromise = findAllRouterFiles(workspaceRoot)
                 .then(parseAllRoutersAst) // Use AST parser
                 .then(routes => {
                     const map = new Map<string, string[]>();
                     for(const route of routes) {
                         const existing = map.get(route.componentFilename) || [];
                         if (!existing.includes(route.fullPath)) { // Avoid duplicate paths for same component
                             existing.push(route.fullPath);
                         }
                         map.set(route.componentFilename, existing);
                     }
                     console.log(`Router map computed. Mapped components: ${map.size}`);
                     return map;
                 });
        }
        if (!importerMapPromise) {
            console.log("Initiating importer map build...");
            importerMapPromise = buildImporterMapAst(workspaceRoot); // Use AST parser
        }
        const [routeMap, importerMap] = await Promise.all([routeMapPromise, importerMapPromise]);
        console.log("Maps are ready.");
        return { routeMap, importerMap };
    }


    let disposable = vscode.commands.registerCommand('vueUsageFinder.findUsage', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return vscode.window.showWarningMessage("No active editor found.");

        const document = editor.document;
        if (document.languageId !== 'vue') return vscode.window.showWarningMessage("Please open a Vue file (.vue).");

        const currentFilePath = document.uri.fsPath;
        const currentFilename = path.basename(currentFilePath);
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (!workspaceFolder) return vscode.window.showWarningMessage("Could not determine workspace folder.");

        const workspaceRoot = workspaceFolder.uri.fsPath;

        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Finding URL usage for ${currentFilename}...`,
            cancellable: false
        }, async (progress) => {
            try {
                progress.report({ increment: 10, message: `Building component/route maps (if needed)...` });
                const { routeMap, importerMap } = await ensureMapsComputed(workspaceRoot);

                if (routeMap.size === 0) {
                     vscode.window.showWarningMessage(`Could not extract any component routes from '${ROUTER_FILENAME}' files using AST parsing.`);
                     return;
                }
                // Importer map can be empty if component is only used directly

                progress.report({ increment: 40, message: `Analyzing import chain...` });
                const urls = await findUrlsViaImports(currentFilename, routeMap, importerMap, new Set());

                progress.report({ increment: 50, message: "Done." });

                // --- Display Results ---
                if (urls.length > 0) {
                    urls.sort();
                    const message = `Component '${currentFilename}' used in URLs:\n- ${urls.join('\n- ')}`;
                     vscode.window.showInformationMessage(message, { modal: true });

                     const outputChannel = vscode.window.createOutputChannel("Vue URL Usage");
                     outputChannel.clear();
                     outputChannel.appendLine(`URLs using component: ${currentFilename}`);
                     urls.forEach(url => outputChannel.appendLine(`- ${url}`));
                     outputChannel.show();
                } else {
                    vscode.window.showInformationMessage(`Component '${currentFilename}' does not appear to lead to any routes found in '${ROUTER_FILENAME}' files via imports.`);
                }
            } catch (error) {
                 console.error("Error finding URL usage:", error);
                 routeMapPromise = null; // Clear cache on error
                 importerMapPromise = null;
                 if (error instanceof Error) {
                    vscode.window.showErrorMessage(`An error occurred while finding URL usage: ${error.message}\nCheck console (Developer Tools) for details.`);
                 } else {
                    vscode.window.showErrorMessage(`An unexpected error occurred while finding URL usage: ${String(error)}`);
                 }
            }
        });
    });

    let clearCacheCommand = vscode.commands.registerCommand('vueUsageFinder.clearCache', () => {
        routeMapPromise = null;
        importerMapPromise = null;
        vscode.window.showInformationMessage("Vue URL Finder cache cleared.");
    });

    context.subscriptions.push(disposable, clearCacheCommand);
}

export function deactivate() {}