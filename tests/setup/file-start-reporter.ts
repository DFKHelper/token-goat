// CI-only: names each test file as it starts so a hung file is visible; vitest.config.ts adds it only under CI.
export interface TestModuleLike {
  relativeModuleId: string
}

export default class FileStartReporter {
  private readonly now: () => Date

  constructor(now: () => Date = () => new Date()) {
    this.now = now
  }

  onTestModuleStart(testModule: TestModuleLike): void {
    process.stdout.write(`[file-start] ${testModule.relativeModuleId} started ${this.now().toISOString()}\n`)
  }
}
