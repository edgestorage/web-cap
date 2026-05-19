import { writeGeneratedWebCapBuildId } from '../lib/server/build-id';

async function main(): Promise<void> {
  const buildId = await writeGeneratedWebCapBuildId();
  console.log(`WEB_CAP build id: ${buildId}`);
}

main().catch((error) => {
  console.error('Failed to generate WEB_CAP build id:', error);
  process.exit(1);
});
