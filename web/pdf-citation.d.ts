export interface PdfTextItem {str:string;fontName?:string;transform:number[];width:number;height:number;dir?:string}
export interface PdfTextIndex {text:string;spans:Array<{start:number;end:number;item:PdfTextItem;style:{ascent?:number}}>}
export interface PdfCitationMatch {ranges:Array<{start:number;end:number}>;matched:number;coverage:number;complete:boolean}
export function normalizePdfText(text:string):string;
export function indexPdfText(content:{items:Array<PdfTextItem|{type:string}>;styles?:Record<string,{ascent?:number}>}):PdfTextIndex;
export function matchPdfCitation(index:PdfTextIndex,source:string):PdfCitationMatch|null;
export function citationBoxes(index:PdfTextIndex,match:PdfCitationMatch,viewport:{transform:number[]}):Array<{left:number;top:number;width:number;height:number;angle:number}>;
