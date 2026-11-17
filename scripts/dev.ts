// Compile with tsc: Bun runs the emitted JS so Nest receives decorator metadata.
async function main(): Promise<void> {
  const build = Bun.spawn(['bun', 'run', '--bun', 'build'], { stdout: 'inherit', stderr: 'inherit' });
  const buildExitCode = await build.exited;
  if (buildExitCode !== 0) process.exit(buildExitCode);

  const compiler = Bun.spawn(['bun', 'run', '--bun', 'tsc', '-p', 'tsconfig.build.json', '--watch', '--preserveWatchOutput'], {
    stdout: 'inherit', stderr: 'inherit',
  });
  const application = Bun.spawn(['bun', '--watch', 'dist/main.js'], { stdout: 'inherit', stderr: 'inherit' });

  let stopping = false;
  function stop(exitCode: number): void {
    if (stopping) return;
    stopping = true;
    compiler.kill('SIGTERM');
    application.kill('SIGTERM');
    void Promise.all([compiler.exited, application.exited]).then(() => process.exit(exitCode));
  }

  process.once('SIGINT', () => stop(0));
  process.once('SIGTERM', () => stop(0));
  void compiler.exited.then((code) => stop(code || 1));
  void application.exited.then((code) => stop(code));
}

void main().catch(() => {
  console.error('Development process failed');
  process.exitCode = 1;
});
