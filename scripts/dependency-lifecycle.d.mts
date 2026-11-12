export function createDependencyLifecycle(options: {
  project: string;
  service: string;
  compose(args: string[]): Promise<string>;
  docker(args: string[]): Promise<string>;
}): {
  stop(): Promise<void>;
  start(): Promise<void>;
};
