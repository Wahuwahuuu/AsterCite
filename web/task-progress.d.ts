import type {TaskProgress} from '../agent/task-progress.ts';
export function taskSummary(progress?:TaskProgress|null):{total:number;done:number;gaps:number};
