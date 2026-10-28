import type {WebSource} from '../agent/web-session.ts';
export function markdownToHtml(text:string,options?:{sources?:WebSource[];interactive?:boolean}):string;
export function renderMarkdown(target:HTMLElement,text:string,options?:{sources?:WebSource[];onCitation?:(index:number)=>void;onCitationHover?:(index:number)=>void}):void;
