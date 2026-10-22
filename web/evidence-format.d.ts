export type EvidenceBlock =
  | {kind:"paragraph"|"heading";text:string}
  | {kind:"table";caption:string;headers:[string,string];rows:[string,string][];omittedRows?:number};
export function parseEvidenceText(text:string):EvidenceBlock[];
export function evidencePreview(blocks:EvidenceBlock[],limit?:number,maxRows?:number):{blocks:EvidenceBlock[];hasMore:boolean};
