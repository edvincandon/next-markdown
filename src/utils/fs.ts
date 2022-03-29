import fs from 'fs';
import { join } from 'path';

import { File, TreeObject } from '../types.js';
import { pathToLocalGitRepo } from './constants.js';

export const getContentPath = (pathToContent: string, remote: boolean) => {
  return remote ? join(pathToLocalGitRepo, pathToContent) : join(process.cwd(), pathToContent);
};

export const exclude = (object: TreeObject) => {
  if (object.type === 'file' && object.name.endsWith('.md') === false) {
    return true;
  }

  if (object.name === '.git') {
    return true;
  }

  if (object.type === 'dir' && object.children.length === 0) {
    return true;
  }

  return false;
};

export const treeSync = (path: string) => {
  const res = fs
    .readdirSync(path)
    .map((e) => ({ name: e, path: join(path, e) }))
    .map(
      (
        (fileSystem: typeof fs) =>
        (e): TreeObject | null => {
          const isDir = fileSystem.lstatSync(e.path).isDirectory();
          if (e.name === '.git') {
            return null; // no need to inspect recursively this
          } else {
            return isDir
              ? { type: 'dir', ...e, children: treeSync(e.path) }
              : {
                  type: 'file',
                  ...e,
                };
          }
        }
      )(fs),
    )
    .flatMap((f) => (f ? [f] : []))
    .filter((e) => exclude(e) === false);

  return res;
};

export const flatFiles = (tree: TreeObject[]): File[] => {
  const flatRecursively = (object: TreeObject): TreeObject[] =>
    object.type === 'dir' ? object.children.flatMap(flatRecursively) : [object];

  return tree.flatMap(flatRecursively) as File[];
};

export const generatePathsFromFiles = (files: File[], pathToLocalRepo: string) => {
  return files.map((e) => {
    const nextmd = getNextmdFromFilePath(e.path, pathToLocalRepo);

    return {
      nextmd,
      treeObject: e,
    };
  });
};

export const getNextmdFromFilePath = (filePath: string, pathToLocalRepo: string) => {
  return (filePath.endsWith('index.md') ? filePath.replace('index.md', '') : filePath)
    .replace(pathToLocalRepo, '')
    .replace('.md', '')
    .replace(/\/\d{4}-\d{2}-\d{2}(.)/, '/') // replace string starting with "/YYYY-MM-DD-" with "/"
    .split('/')
    .filter((e) => e);
};
