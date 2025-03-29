# Vue URL Finder (VS Code Extension)

A Visual Studio Code extension designed to help you quickly find the URL routes associated with the currently open Vue.js component file within your workspace.

This extension is particularly useful in larger Vue projects where tracing component usage back to specific URLs defined in router files can be time-consuming.

## Features

*   **Find URL Usage:** Activate a command to identify the router paths where the currently active `.vue` component is used.
*   **Import Hierarchy Traversal:** Recursively searches upwards through the component import chain. It finds components that import the current one, then components that import those parents, and so on.
*   **Router File Scanning:** Locates files named `router.ts` within your workspace (ignoring `node_modules`).
*   **Route Parsing:** Attempts to parse route definitions within found `router.ts` files to link components to URL paths. (See Limitations).
*   **Clear Output:** Displays the found URLs in an information message popup and in a dedicated "Vue URL Usage" Output channel for easy viewing and copying.

## Requirements

*   Visual Studio Code version `^1.80.0` (or higher, match your `package.json`'s `engines.vscode` value).
*   A Vue.js project opened as the workspace root.
*   Project dependencies (like `@typescript-eslint/typescript-estree` for AST parsing) are for the extension's *development*, not required for *users* installing the packaged extension.

## Installation

**1. From VS Code Marketplace**

*   Open the Extensions view (`Ctrl+Shift+X` or `Cmd+Shift+X`).
*   Search for `Vue URL Finder` (or by publisher name: `<your-publisher-name>.vue-url-finder`).
*   Click **Install**.

**2. From `.vsix` File (Manual Installation)**

*   Download the `.vsix` file (e.g., from a release or built locally using `vsce package`).
*   Open the Extensions view (`Ctrl+Shift+X` or `Cmd+Shift+X`).
*   Click the "..." (More Actions) menu in the top-right corner of the Extensions view sidebar.
*   Select **"Install from VSIX..."**.
*   Browse to and select the downloaded `.vsix` file.
*   Alternatively, use the command line:
    ```bash
    code --install-extension path/to/your/vue-url-finder-x.x.x.vsix
    ```

## Usage

1.  Open your Vue.js project in VS Code.
2.  Open the specific `.vue` component file you want to investigate.
3.  Open the Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P`).
4.  Type or select the command: `Vue Usage: Find URL Usage`.
5.  The extension will scan for `router.ts` files, parse routes, build an import map (this might take a few seconds, especially on first run or large projects), and trace the usage of your component.
6.  If associated URLs are found, they will be displayed in:
    *   An information message popup (modal).
    *   The "Output" panel under the "Vue URL Usage" channel.

## Configuration

Currently, this extension relies on convention and does not have user-configurable settings. It automatically searches for files named `router.ts`.

## Known Issues & Limitations

This extension uses Abstract Syntax Trees (AST) for parsing, which is significantly more robust than the previous regex approach, but some limitations may still exist:

*   **Router Structure:** Assumes a common router setup using `createRouter` and a `routes` array within files named `router.ts`. Complex or highly unconventional router definitions might not be fully parsed.
*   **Import Parsing (`buildImporterMapAst`):** The logic for finding imports within `<script>` tags is basic. It might miss imports from `<script setup>` if not handled explicitly or complex import/export patterns within Vue files. A full SFC parser (`@vue/compiler-sfc`) would be more robust.
*   **Dynamic Components/Routes:** Components loaded dynamically using `<component :is="...">` or routes added programmatically *after* the initial router definition might not be detected.
*   **Performance:** Building the initial importer map (`buildImporterMapAst`) involves scanning all `.vue` files in the workspace. This might be slow on very large projects the first time the command is run after activation or cache clearing. Subsequent runs should be faster as the maps are cached in memory for the session.
*   **Path Alias Resolution:** This version does *not* resolve path aliases (like `@/`). It relies on matching component *filenames*. If multiple components share the same filename but exist in different aliased paths, the results might be ambiguous or incorrect depending on the import statements found.

## Release Notes

See the [CHANGELOG.md](CHANGELOG.md) file for details on changes between versions.

## Contributing

Contributions, issues, and feature requests are welcome! Please check the [repository issues](https://github.com/rrgrs/vue-url-finder-ext/issues) page (replace with your actual repo link).