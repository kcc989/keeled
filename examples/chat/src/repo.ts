/** A small in-memory repository so the example runs without touching a disk. */
export interface RepoFile {
  path: string;
  contents: string;
}

export interface ReplacementResult {
  path: string;
  replacements: number;
}

export class Repo {
  #files: RepoFile[];
  #testsPass = false;

  constructor(files: RepoFile[]) {
    this.#files = files;
  }

  search(query: string): RepoFile[] {
    const needle = query.toLowerCase();

    return this.#files.filter(
      (file) => file.path.toLowerCase().includes(needle) || file.contents.toLowerCase().includes(needle),
    );
  }

  read(path: string): string | undefined {
    return this.#files.find((file) => file.path === path)?.contents;
  }

  replace(path: string, from: string, to: string): ReplacementResult {
    const file = this.#files.find((candidate) => candidate.path === path);

    if (file === undefined) throw new Error(`No such file: ${path}`);

    if (!file.contents.includes(from)) {
      throw new Error(`"${from}" does not appear in ${path}`);
    }

    const contents = file.contents.split(from).join(to);
    const replacements = file.contents.split(from).length - 1;
    file.contents = contents;
    this.#testsPass = contents.includes('formatPrice');

    return { path, replacements };
  }

  runTests(): { passed: boolean; failures: string[] } {
    return this.#testsPass
      ? { passed: true, failures: [] }
      : { passed: false, failures: ['pricing.test.ts: formatPrice is not exported'] };
  }
}
