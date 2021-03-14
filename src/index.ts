import { Plugin } from 'esbuild';
import fs from 'fs';
import gql from 'graphql-tag';
import { OperationDefinitionNode, DocumentNode } from 'graphql';
import readline from 'readline';
import path from 'path';

interface GraphQLLoaderPluginOptions {
  filterRegex?: RegExp;
  mapDocumentNode?: (documentNode: DocumentNode) => DocumentNode;
}

interface Import {
  absolutePath: string;
  relativePath: string;
}

interface ParsedGraphQLFile {
  body: string;
  filePath: string;
  imports: Import[];
}

// Definitions can be undefined, which will get stripped when JSON.stringify is
// run. For that reason, we temporarily serialize undefined, then swap it back
// to the value of undefined.
//
const generateDocumentNodeString = (
  graphqlDocument: DocumentNode,
  mapDocumentNode?: (documentNode: DocumentNode) => DocumentNode
): string => {
  const documentNodeToUse = mapDocumentNode
    ? mapDocumentNode(graphqlDocument)
    : graphqlDocument;

  return JSON.stringify(documentNodeToUse, (key, value) =>
    value === undefined ? '__undefined' : value
  ).replace(/"__undefined"/g, 'undefined');
};

const topologicallySortParsedFiles = (
  parsedFiles: ParsedGraphQLFile[],
  cache: Record<string, ParsedGraphQLFile>
): ParsedGraphQLFile[] => {
  const visitedFiles = new Set();
  const sorted: ParsedGraphQLFile[] = [];

  const visitFile = (file: ParsedGraphQLFile): void => {
    if (visitedFiles.has(file)) return;

    visitedFiles.add(file);

    file.imports.forEach((importFileEntry) => {
      const importedFile = cache[importFileEntry.absolutePath];

      visitFile(importedFile);
    });

    sorted.unshift(file);
  };

  parsedFiles.forEach(visitFile);

  return sorted;
};

type ValidImportCommentPrefix = '#import ' | '# import ';

const parseGraphQLFile = (filePath: string): Promise<ParsedGraphQLFile> =>
  new Promise((resolve) => {
    const readInterface = readline.createInterface({
      input: fs.createReadStream(filePath),
    });
    let body = '';
    const imports: Import[] = [];

    let hasExhaustedImports = false;

    const parseImportAndCapture = (
      importCommentPrefix: ValidImportCommentPrefix,
      line: string
    ): void => {
      const relativePath = line.replace(importCommentPrefix, '');
      const absolutePath = path.join(path.dirname(filePath), relativePath);
      imports.push({
        absolutePath,
        relativePath,
      });
    };

    readInterface.on('line', (line) => {
      if (line.startsWith('#import ')) {
        parseImportAndCapture('#import ', line);
      } else if (line.startsWith('# import ')) {
        parseImportAndCapture('# import ', line);
      } else if (hasExhaustedImports) {
        body += line + '\n';
      } else if (line[0] !== '#' && line !== '') {
        hasExhaustedImports = true;
        body += line + '\n';
      }
    });

    readInterface.on('close', () => {
      resolve({ body: body.trim(), filePath, imports });
    });
  });

const generateGraphQLString = (entryPointPath: string): Promise<string> => {
  const cache: Record<string, ParsedGraphQLFile> = {};
  const parsePromises: Promise<null>[] = [];
  const seenImportPaths = new Set();

  const visitAndParse = (filePath: string): Promise<null> => {
    if (cache[filePath]) return Promise.resolve(null);

    return new Promise((resolve) => {
      parseGraphQLFile(filePath).then((parsedFile) => {
        cache[parsedFile.filePath] = parsedFile;

        parsedFile.imports.forEach((importEntry) => {
          if (!seenImportPaths.has(importEntry.absolutePath)) {
            seenImportPaths.add(importEntry.absolutePath);
            parsePromises.push(visitAndParse(importEntry.absolutePath));
          }
        });

        const nextPromise = parsePromises.shift();
        if (nextPromise) {
          return nextPromise.then(resolve);
        }

        return resolve(null);
      });
    });
  };

  return visitAndParse(entryPointPath).then(() => {
    const files = topologicallySortParsedFiles(Object.values(cache), cache);

    const graphqlString = files.reduce((accumulator, file) => {
      return file.body + '\n\n' + accumulator;
    }, '');

    return graphqlString;
  });
};

const generateDocumentNodeStringForOperationDefinition = (
  operationDefinition: OperationDefinitionNode,
  mapDocumentNode?: (documentNode: DocumentNode) => DocumentNode
): string => {
  const operationDocument: DocumentNode = {
    kind: 'Document',
    definitions: [operationDefinition],
  };

  return generateDocumentNodeString(operationDocument, mapDocumentNode);
};

const generateContentsFromGraphqlString = (
  graphqlString: string,
  mapDocumentNode?: (documentNode: DocumentNode) => DocumentNode
): string => {
  const graphqlDocument = gql(graphqlString);
  const documentNodeAsString = generateDocumentNodeString(
    graphqlDocument,
    mapDocumentNode
  );

  const lines = graphqlDocument.definitions.reduce<string[]>(
    (accumulator, definition) => {
      if (
        definition.kind === 'OperationDefinition' &&
        definition.name &&
        definition.name.value
      ) {
        const name = definition.name.value;
        const operationDocumentString = generateDocumentNodeStringForOperationDefinition(
          definition,
          mapDocumentNode
        );
        accumulator.push(`export const ${name} = ${operationDocumentString};`);
      }

      return accumulator;
    },
    [`const documentNode = ${documentNodeAsString};`]
  );

  lines.push(`export default documentNode;`);

  return lines.join('\n');
};

const graphqlLoaderPlugin = (
  options: GraphQLLoaderPluginOptions = {}
): Plugin => ({
  name: 'graphql-loader',
  setup(build) {
    build.onLoad({ filter: options.filterRegex || /\.graphql$/ }, (args) =>
      generateGraphQLString(args.path).then((graphqlString) => ({
        contents: generateContentsFromGraphqlString(
          graphqlString,
          options.mapDocumentNode
        ),
      }))
    );
  },
});

export default graphqlLoaderPlugin;
