import { exec } from 'child_process';
import fs from 'fs';
import { join } from 'path';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import { rehypeVideos } from './rehype-videos';
import { NextMdConfig, YAMLFrontMatter } from './types';
import matter from 'gray-matter';

const NextMd = <PageFrontMatter extends YAMLFrontMatter, PostPageFrontMatter extends PageFrontMatter>(
  config: NextMdConfig,
) => {
  return {
    getStaticPaths: async () => {
      const localRepoPath = getContentPath(config);
      const tree = await treeContentRepo(localRepoPath, config);
      const files = flatFiles(tree);
      const staticContents = generatePathsFromFiles(files, localRepoPath);

      return {
        paths: staticContents.map((e) => ({
          params: {
            nextmd: e.nextmd,
          },
        })),
        fallback: false, // See the "fallback" section below
      };
    },
    getStaticProps: async (context: { params?: { nextmd: string[] } }) => {
      const localRepoPath = getContentPath(config);
      const tree = await treeContentRepo(localRepoPath, config);
      const files = flatFiles(tree);
      const staticContents = generatePathsFromFiles(files, localRepoPath);

      const nextmd = context.params?.nextmd;

      if (nextmd === undefined) {
        throw Error('Could not find params "nextmd". Do you name the file `[...nextmd].tsx` or `[...nextmd].jsx`?');
      }

      const data = staticContents.filter((e) => JSON.stringify(e.nextmd) === JSON.stringify(nextmd));

      if (data.length === 0) {
        throw Error(`Could not find markdown file for path /${nextmd.join('/')}`);
      } else if (data.length > 1) {
        throw Error(`Duplicate page detected ${data.map((e) => e.treeObject.path).join(', ')}`);
      }

      const content = data[0];

      const postsPageData = await getPostsFromNextmd<PostPageFrontMatter>(files, localRepoPath, nextmd);

      const rawdata = fs.readFileSync(content.treeObject.path).toString('utf-8');
      const pageData = await getPageDataFromMarkdownFileRawData<PageFrontMatter>(rawdata);

      return {
        props: {
          ...pageData,
          slug: getSlugFromNextmd(nextmd),
          parentRoute: getParentFromNextmd(nextmd),
          posts: postsPageData,
        },
      };
    },
  };
};

export default NextMd;

// -------
// Utils
// -------

const pathToLocalGitRepo = join(process.cwd(), '.git/next-md/');
const pathToNextmdLastUpdate = join(process.cwd(), '.git/next-md-last-update');

const consoleLogNextmd = (...args: (string | undefined | null)[]) => {
  args.unshift('[nextmd]');
  console.log.apply(this, args); // tslint:disable-line:no-console
};

const getContentPath = (config: NextMdConfig) => {
  return config.contentGitRemoteUrl ? join(pathToLocalGitRepo, config.pathToContent) : config.pathToContent;
};

async function getPostsFromNextmd<T extends YAMLFrontMatter>(files: File[], localRepoPath: string, nextmd: string[]) {
  type PostFile = { file: File; date: string };

  const posts = files.reduce<PostFile[]>((prev, curr) => {
    const matches = curr.name.match(/^\d{4}-\d{2}-\d{2}/i);
    if (curr.path.startsWith(join(localRepoPath, nextmd.join('/'))) && matches && matches.length > 0) {
      return prev.concat([{ file: curr, date: matches[0] }]);
    }
    return prev;
  }, []);

  return posts.length === 0
    ? null
    : await Promise.all(
        posts.map(async (e) => {
          const rawdata = fs.readFileSync(e.file.path).toString('utf-8');
          const postPageData = await getPageDataFromMarkdownFileRawData<T>(rawdata);
          const postNextmd = getNextmdFromFilePath(e.file.path, localRepoPath);
          return {
            ...postPageData,
            slug: getSlugFromNextmd(postNextmd),
            date: e.date,
          };
        }),
      );
}

async function treeContentRepo(pathToContent: string, config: NextMdConfig) {
  if (!config.contentGitRemoteUrl) {
    consoleLogNextmd('creating page from', pathToContent);
    return treeSync(pathToContent);
  }

  /**
   * Returns the number of seconds elasped since the last update of the git remote repo.
   */
  const elapsedSecondsSinceLastUpdate = () => {
    const lastRepoUpdateTxt = fs.readFileSync(pathToNextmdLastUpdate).toString('utf-8');
    const lastUpdateMillis = parseInt(lastRepoUpdateTxt, 10);

    return Date.now() - lastUpdateMillis;
  };

  /**
   * Mechanism to avoid pulling the repo when `getStaticPaths` & `getStaticProps` is called.
   *
   * This ensures repo content is the same in `getStaticPaths` & `getStaticProps`.
   */
  const updateGitRepo = () => {
    if (fs.existsSync(pathToNextmdLastUpdate) === false) {
      return true;
    }

    return elapsedSecondsSinceLastUpdate() > 5 * 60 * 1000; // 5 minutes
  };

  if (updateGitRepo()) {
    consoleLogNextmd('resolving contents from', config.contentGitRemoteUrl);
    fs.writeFileSync(pathToNextmdLastUpdate, `${Date.now()}`);
    await cmd(`git -C ${pathToContent} pull || git clone ${config.contentGitRemoteUrl} ${pathToContent}`);
  }

  consoleLogNextmd('creating page from', config.contentGitRemoteUrl);

  return treeSync(pathToContent);
}

function cmd(commandLine: string) {
  return new Promise((resolve, reject) => {
    exec(commandLine, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      }
      resolve(stdout || stderr);
    });
  });
}

const exclude = (object: TreeObject) => {
  if (object.type === 'file' && object.name.endsWith('.md') === false) {
    return true;
  }

  if (object.name === 'README.md') {
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

const include = (object: TreeObject) => !exclude(object);

function treeSync(path: string) {
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
    .filter(include);

  return res;
}

type Dir = {
  type: 'dir';
  name: string;
  path: string;
  children: TreeObject[];
};

type File = {
  type: 'file';
  name: string;
  path: string;
};

type TreeObject = Dir | File;

const flatFiles = (tree: TreeObject[]): File[] => {
  const flatRecursively = (object: TreeObject): TreeObject[] =>
    object.type === 'dir' ? object.children.flatMap(flatRecursively) : [object];

  return tree.flatMap(flatRecursively) as File[];
};

const generatePathsFromFiles = (files: File[], pathToLocalRepo: string) => {
  return files.map((e) => {
    const nextmd = getNextmdFromFilePath(e.path, pathToLocalRepo);

    return {
      nextmd,
      treeObject: e,
    };
  });
};

const getNextmdFromFilePath = (filePath: string, pathToLocalRepo: string) => {
  return (filePath.endsWith('index.md') ? filePath.replace('index.md', '') : filePath)
    .replace(pathToLocalRepo, '')
    .replace('.md', '')
    .replace(/\/\d{4}-\d{2}-\d{2}(.)/, '/') // replace string starting with "/YYYY-MM-DD-" with "/"
    .split('/')
    .filter((e) => e);
};

const getSlugFromNextmd = (nextmd: string[]) => nextmd.slice(-1).pop() ?? ''; // last element without modifying the original array

const getParentFromNextmd = (nextmd: string[]) => '/' + nextmd.slice(0, -1).join('/'); // remove last element of array

async function getPageDataFromMarkdownFileRawData<T extends YAMLFrontMatter>(rawdata: string) {
  const { data, content } = matter(rawdata);
  const html = await markdownToHtml(content);

  return {
    frontMatter: data as T,
    html,
  };
}

async function markdownToHtml(markdown: string) {
  const result = await unified()
    .use(remarkParse)
    .use(remarkRehype)
    .use(rehypeVideos)
    .use(rehypeStringify)
    .process(markdown);

  return String(result);
}
