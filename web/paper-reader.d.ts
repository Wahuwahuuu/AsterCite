export class PaperReader {
  constructor(options:Record<string,unknown>);
  open(paper:{paper_id:string;title:string},accessToken?:string,force?:boolean):Promise<void>;
  show(page:number):Promise<void>;
}
