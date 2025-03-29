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
        const filename = variableToFilenameMap.get(componentNode.name);
        if (filename) {
             console.log(`[AST Comp Resolve] Resolved Identifier '${componentNode.name}' to filename '${filename}'`);
             return filename;
        } else {
             console.log(`[AST Comp Resolve] Identifier '${componentNode.name}' not found in variable map.`);
             return null;
        }
    }

    // Case 2: component: () => import('./path/MaybeFile.vue')
    if (componentNode.type === AST_NODE_TYPES.ArrowFunctionExpression) {
        if (componentNode.body.type === AST_NODE_TYPES.ImportExpression) {
            const importSource = componentNode.body.source;
            if (importSource.type === AST_NODE_TYPES.Literal && typeof importSource.value === 'string') {
                 // ONLY return if it explicitly ends with .vue
                 if (importSource.value.endsWith('.vue')) {
                     const filename = path.basename(importSource.value);
                     console.log(`[AST Comp Resolve] Resolved ArrowFunc Import '${importSource.value}' to filename '${filename}'`);
                     return filename;
                 } else {
                     // It's an arrow function import, but not a .vue file (e.g., index.ts)
                     console.log(`[AST Comp Resolve] Ignoring ArrowFunc Import of non-Vue file: '${importSource.value}'`);
                     return null; // Ignore non-vue imports silently
                 }
            }
        }
        // --- ADDED Check for import().then() ---
        else if (componentNode.body.type === AST_NODE_TYPES.CallExpression &&
                 componentNode.body.callee.type === AST_NODE_TYPES.MemberExpression &&
                 componentNode.body.callee.object.type === AST_NODE_TYPES.ImportExpression &&
                 componentNode.body.callee.property.type === AST_NODE_TYPES.Identifier &&
                 componentNode.body.callee.property.name === 'then')
        {
             // It's an import(...).then(...) structure. We could try parsing the .then()
             // callback, but for now, let's just ignore it as it's complex and might not yield a simple filename.
             console.log(`[AST Comp Resolve] Ignoring ArrowFunc with import().then() structure.`);
             return null;
        }
         // --- END ADDED Check ---
    }

     // Case 3: defineAsyncComponent(() => import(...))
     if (componentNode.type === AST_NODE_TYPES.CallExpression && componentNode.callee.type === AST_NODE_TYPES.Identifier && componentNode.callee.name === 'defineAsyncComponent' && componentNode.arguments.length > 0) {
         const arg = componentNode.arguments[0];
          if (arg.type === AST_NODE_TYPES.ArrowFunctionExpression && arg.body.type === AST_NODE_TYPES.ImportExpression) {
             const importSource = arg.body.source;
             if (importSource.type === AST_NODE_TYPES.Literal && typeof importSource.value === 'string') {
                  // ONLY return if it explicitly ends with .vue
                  if (importSource.value.endsWith('.vue')) {
                      const filename = path.basename(importSource.value);
                      console.log(`[AST Comp Resolve] Resolved defineAsyncComponent Import '${importSource.value}' to filename '${filename}'`);
                      return filename;
                  } else {
                       console.log(`[AST Comp Resolve] Ignoring defineAsyncComponent Import of non-Vue file: '${importSource.value}'`);
                       return null; // Ignore non-vue imports silently
                  }
             }
         }
     }

    // Removed the generic warning as it's often just noise for valid non-component imports/structures
    // console.warn(`[AST] Unsupported or ignored component definition type: ${componentNode.type}`);
    console.log(`[AST Comp Resolve] Unsupported or ignored component definition type: ${componentNode.type}`); // Keep as log for debugging
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
            // console.warn(`[AST ${routerFilePath}] Skipping non-object element in routes array:`, element?.type);
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
                     console.warn(`[AST ${routerFilePath}] Non-string literal found for 'path':`, valueNode.type);
                }
            } else if (keyName === 'component') {
                if (valueNode.type === AST_NODE_TYPES.Identifier || valueNode.type === AST_NODE_TYPES.ArrowFunctionExpression || valueNode.type === AST_NODE_TYPES.CallExpression) {
                    componentFilename = getComponentFilenameFromNode(valueNode, variableToFilenameMap);
                }
                 if (!componentFilename) {
                     // Optional: Log if component wasn't resolvable
                     // console.warn(`[AST ${routerFilePath}] Could not resolve component filename for path segment '${currentSegment}'. Node type: ${valueNode.type}`);
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

            console.log(`[AST ${routerFilePath}] Found Route: FullPath='${fullPath}', Component='${componentFilename}'`);
            extractedRoutes.push({ fullPath, componentFilename });
        } else if (currentSegment !== null && componentFilename === null) {
             // Log routes with paths but no resolvable component if desired for debugging
            // console.log(`[AST ${routerFilePath}] Found route with path '${currentSegment}' but no resolvable component filename.`);
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
    const logPrefix = `[AST ${routerFilePath}]`;
    console.log(`${logPrefix} Parsing router file: ${routerFilePath}`);
    try {
        const fileContent = await fs.readFile(routerFilePath, 'utf-8');
        // Try disabling JSX if it's definitely not used in router files
        const ast = parse(fileContent, { jsx: false, loc: false, range: false, errorOnUnknownASTType: false, useJSXTextNode: false });

        const variableToFilenameMap = new Map<string, string>();
        let routesArrayNode: TSESTree.ArrayExpression | null = null;
        let routesIdentifierName: string | null = null;
        let routerVariableName: string | null = null;
        let potentialRoutesValueNode: TSESTree.Expression | null = null; // Track the node found

        console.log(`${logPrefix} Starting AST traversal...`);

        // --- First Pass: Find potential routes node (Array or Identifier) and imports ---
        for (const node of ast.body) {
            console.log(`${logPrefix} Processing Top Level Node Type: ${node.type}`);

            // 1. Find Imports
            if (node.type === AST_NODE_TYPES.ImportDeclaration && node.source.type === AST_NODE_TYPES.Literal && typeof node.source.value === 'string' && node.source.value.endsWith('.vue')) {
                if (node.specifiers.length > 0 && node.specifiers[0].type === AST_NODE_TYPES.ImportDefaultSpecifier) {
                    const variableName = node.specifiers[0].local.name;
                    const filename = path.basename(node.source.value);
                    variableToFilenameMap.set(variableName, filename);
                    console.log(`${logPrefix} Mapped import variable '${variableName}' to '${filename}'`);
                }
            }

            // 2. Find 'const router = createRouter({ ... routes: ROUTES / [...] })'
            if (node.type === AST_NODE_TYPES.VariableDeclaration) {
                console.log(`${logPrefix} Found VariableDeclaration.`);
                for (const declaration of node.declarations) {
                    if (declaration.id.type === AST_NODE_TYPES.Identifier && declaration.init?.type === AST_NODE_TYPES.CallExpression) {
                        const callExpr = declaration.init;
                        // Basic check for createRouter (improve if needed)
                        if (callExpr.callee.type === AST_NODE_TYPES.Identifier /* && callExpr.callee.name === 'createRouter' */ && callExpr.arguments.length > 0 && callExpr.arguments[0].type === AST_NODE_TYPES.ObjectExpression) {
                             console.log(`${logPrefix} Found potential createRouter call in variable '${declaration.id.name}'.`);
                            const configObject = callExpr.arguments[0];
                            const routesProp = configObject.properties.find(p =>
                                p.type === AST_NODE_TYPES.Property &&
                                p.key.type === AST_NODE_TYPES.Identifier &&
                                p.key.name === 'routes'
                            ) as TSESTree.Property | undefined;

                            if (routesProp) {
                                console.log(`${logPrefix} Found 'routes' property in createRouter call.`);
                                if (routesProp.value.type === AST_NODE_TYPES.ArrayExpression || routesProp.value.type === AST_NODE_TYPES.Identifier) {
                                    console.log(`${logPrefix} Assigning to potentialRoutesValueNode (type: ${routesProp.value.type})`);
                                    potentialRoutesValueNode = routesProp.value; // Assign here
                                } else {
                                     console.warn(`${logPrefix} 'routes' property value in variable '${declaration.id.name}' assignment has unexpected type: ${routesProp.value.type}.`);
                                }
                                // Assign routerVariableName regardless if routesProp was found with expected types
                                routerVariableName = declaration.id.name;
                                console.log(`${logPrefix} Set routerVariableName = '${routerVariableName}'. Current potentialRoutesValueNode type = ${potentialRoutesValueNode?.type}`);
                            } else {
                                console.log(`${logPrefix} 'routes' property not found in createRouter config object.`);
                            }
                        }
                    }
                }
            }

            // 3. Find 'export default createRouter({ ... })' OR 'export default router;'
            if (node.type === AST_NODE_TYPES.ExportDefaultDeclaration) {
                 console.log(`${logPrefix} Found ExportDefaultDeclaration.`);
                let declarationToCheck = node.declaration;

                 // Handle case: export default router;
                 if (declarationToCheck.type === AST_NODE_TYPES.Identifier && declarationToCheck.name === routerVariableName) {
                    console.log(`${logPrefix} Confirmed export of tracked variable '${routerVariableName}'. Checking potentialRoutesValueNode...`);

                    const currentNode = potentialRoutesValueNode; // Use a local const for clarity

                    // --- Refined Type Checking ---
                    if (currentNode === null) {
                        // Case 1: It was null all along
                        console.warn(`${logPrefix} Exported variable '${routerVariableName}', but potentialRoutesValueNode is null.`);
                    } else if (currentNode.type === AST_NODE_TYPES.ArrayExpression) {
                        // Case 2: It's the Array we want
                        console.log(`${logPrefix} Assigning potentialRoutesValueNode (Array) to routesArrayNode and breaking.`);
                        routesArrayNode = currentNode;
                        break; // Found the definitive routes array via exported variable
                    } else if (currentNode.type === AST_NODE_TYPES.Identifier) {
                        // Case 3: It's an Identifier we need to resolve later
                        console.log(`${logPrefix} Setting routesIdentifierName from potentialRoutesValueNode: '${currentNode.name}'.`);
                        routesIdentifierName = currentNode.name;
                        // Don't break - need to potentially find the identifier's definition later
                    } else {
                        // Case 4: It's not null, not Array, not Identifier - must be some other Expression type
                        // Accessing .type here should be safe because we already ruled out null.
                        const nodeType = (currentNode as TSESTree.Expression).type;
                        console.warn(`${logPrefix} Exported variable '${routerVariableName}', but potentialRoutesValueNode is an unexpected Expression type (Actual Type: ${nodeType}).`);
                    }
                }
                 // Handle case: export default createRouter(...)
                 else if (declarationToCheck.type === AST_NODE_TYPES.CallExpression) {
                      console.log(`${logPrefix} Export default is a CallExpression.`);
                     // Basic check for createRouter (improve if needed)
                    if (declarationToCheck.callee.type === AST_NODE_TYPES.Identifier /* && declarationToCheck.callee.name === 'createRouter' */ && declarationToCheck.arguments.length > 0 && declarationToCheck.arguments[0].type === AST_NODE_TYPES.ObjectExpression) {
                         console.log(`${logPrefix} Export default is a createRouter call.`);
                        const configObject = declarationToCheck.arguments[0];
                        const routesProp = configObject.properties.find(p =>
                            p.type === AST_NODE_TYPES.Property &&
                            p.key.type === AST_NODE_TYPES.Identifier &&
                            p.key.name === 'routes'
                        ) as TSESTree.Property | undefined;

                        if (routesProp) {
                            console.log(`${logPrefix} Found 'routes' property in export default createRouter.`);
                            if (routesProp.value.type === AST_NODE_TYPES.ArrayExpression) {
                                console.log(`${logPrefix} Assigning direct ArrayExpression to routesArrayNode and breaking.`);
                                routesArrayNode = routesProp.value;
                                break; // Found the array directly
                            } else if (routesProp.value.type === AST_NODE_TYPES.Identifier) {
                                console.log(`${logPrefix} Setting routesIdentifierName from export default createRouter: '${routesProp.value.name}'.`);
                                routesIdentifierName = routesProp.value.name;
                                // Don't break - need to potentially find the identifier's definition later
                            } else {
                                console.warn(`${logPrefix} 'routes' property value in export default createRouter has unexpected type: ${routesProp.value.type}.`);
                            }
                        }  else {
                            console.log(`${logPrefix} 'routes' property not found in export default createRouter config object.`);
                        }
                    }
                }
            }

            // 4. Find 'export default localFunctionName(ROUTES_IDENTIFIER)'
            if (node.type === AST_NODE_TYPES.ExportDefaultDeclaration &&
                node.declaration.type === AST_NODE_TYPES.CallExpression &&
                node.declaration.arguments.length === 1 && // Expecting one argument
                node.declaration.arguments[0].type === AST_NODE_TYPES.Identifier && // Argument is an identifier
                node.declaration.callee.type === AST_NODE_TYPES.Identifier) // Callee is an identifier
            {
                // This *might* be the pattern export default createRouter(INITIAL_ROUTES)
                // We don't analyze the function body, just assume the argument IS the routes identifier
                const potentialRoutesIdentifier = node.declaration.arguments[0].name;
                console.log(`${logPrefix} Found potential 'export default functionCall(identifier)' pattern. Assuming '${potentialRoutesIdentifier}' is the routes identifier.`);
                // If we haven't already found routes, store this identifier name
                if (!routesArrayNode && !routesIdentifierName) {
                     routesIdentifierName = potentialRoutesIdentifier;
                }
                // We might have already found the router variable assignment, so don't overwrite if routesIdentifierName was set there.
            }
        } // End First Pass AST body loop

        console.log(`${logPrefix} Finished first pass. routesArrayNode found: ${!!routesArrayNode}, routesIdentifierName: ${routesIdentifierName}`);

        // --- Second Pass (if needed): Find the array if routes were assigned by identifier ---
        if (!routesArrayNode && routesIdentifierName) {
            console.log(`${logPrefix} Searching for declaration of identifier '${routesIdentifierName}'...`);
            for (const node of ast.body) {
                if (node.type === AST_NODE_TYPES.VariableDeclaration) {
                    for (const declaration of node.declarations) {
                        if (declaration.id.type === AST_NODE_TYPES.Identifier && declaration.id.name === routesIdentifierName) {
                            console.log(`${logPrefix} Found declaration for '${routesIdentifierName}'. Checking initializer...`);
                            if (declaration.init?.type === AST_NODE_TYPES.ArrayExpression) {
                                routesArrayNode = declaration.init;
                                console.log(`${logPrefix} Found ArrayExpression definition for '${routesIdentifierName}'. Assigning to routesArrayNode.`);
                                break; // Found it
                            } else {
                                console.warn(`${logPrefix} Variable '${routesIdentifierName}' used for routes is not initialized with an ArrayExpression. Type: ${declaration.init?.type}`);
                            }
                        }
                    }
                }
                if (routesArrayNode) break; // Exit outer loop once found
            }
        }

        console.log(`${logPrefix} Variable Map:`, variableToFilenameMap);

        // --- Process the routes array if found ---
        if (routesArrayNode) {
            console.log(`${logPrefix} Proceeding to process resolved routes array.`);
            return processRoutesAst(routesArrayNode, variableToFilenameMap, '', routerFilePath); // Pass basename here too
        } else {
            console.warn(`${logPrefix} Could not find or resolve 'routes' array in the expected structure.`);
            return [];
        }

    } catch (err) {
        // Log error with prefix
        if (err instanceof Error) {
            console.error(`${logPrefix} Error parsing ${routerFilePath}: ${err.message}`, err.stack);
            vscode.window.showErrorMessage(`Failed to parse router file ${routerFilePath}. Check console for details.`);
        } else {
            console.error(`${logPrefix} Unknown error parsing ${routerFilePath}: ${String(err)}`);
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
            const scriptContentMatch = content.match(/<script(?: setup)?(?:\s+lang=["']ts["'])?>([\s\S]*?)<\/script>/);
            if (!scriptContentMatch || !scriptContentMatch[1]) {
                continue;
            }
            const scriptContent = scriptContentMatch[1];

            const ast = parse(scriptContent, { jsx: false, loc: false, range: false, errorOnUnknownASTType: false, useJSXTextNode: false });

            // Traverse the AST to find imports (existing loop)
            for (const node of ast.body) {
                if (node.type === AST_NODE_TYPES.ImportDeclaration && node.source.type === AST_NODE_TYPES.Literal && typeof node.source.value === 'string') {
                     const importSource = node.source.value;
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
            } // End inner loop (nodes in body)

            scannedCount++;
            if (scannedCount % 100 === 0) console.log(`[AST Importer] Scanned ${scannedCount} files...`);

        } catch (err) {
            if (err instanceof Error) {
                 console.warn(`[AST Importer] Could not read or parse script in ${importerFilePath}: ${err.message}`);
            } else {
                 console.warn(`[AST Importer] Could not read or parse script in ${importerFilePath}: ${String(err)}`);
            }
        }
    } // End outer loop (files)

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