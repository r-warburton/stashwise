import {appendFile} from 'node:fs/promises';
import {checkPublication} from '../lib/pages-schedule.mjs';

const scheduled=process.env.STASHWISE_SCHEDULE_CHECK==='true';
const result=scheduled?await checkPublication({baseUrl:process.env.PAGES_PREVIOUS_URL}):
  {publish:true,reason:'Code push or forced manual run; publish after validation.'};
if(process.env.GITHUB_OUTPUT)await appendFile(process.env.GITHUB_OUTPUT,`publish=${result.publish}\n`);
if(process.env.GITHUB_STEP_SUMMARY)await appendFile(process.env.GITHUB_STEP_SUMMARY,
  `### Price publication check\n\n${result.reason}\n\n${result.oldestCheckedAt?`Oldest successful market check: ${result.oldestCheckedAt} (${result.oldestAgeSeconds}s ago).\n\n`:''}Target: about 15 minutes. GitHub is asked to check every 5 minutes; scheduling can be delayed.\n`);
console.log(JSON.stringify(result));

