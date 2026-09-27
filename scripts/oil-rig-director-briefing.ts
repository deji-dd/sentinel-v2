import { generateAndSendDirectorBriefing } from "../packages/utils";

async function main(): Promise<void> {
	await generateAndSendDirectorBriefing({ useLiveData: true });
}

void main();
