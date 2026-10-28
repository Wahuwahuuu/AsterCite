export function splitAnswerControl(text:string,options?:{streaming?:boolean}):{body:string;control?:Record<string,unknown>};
export function displayPaperTitles(text:string,papers?:readonly {paper_id:string;title:string}[]):string;
