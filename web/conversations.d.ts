export interface Conversation {id:string;token:string;label:string;renamed:boolean;pinned:boolean;archived:boolean;created_at:number;updated_at:number}
export function normalizeConversations(value:unknown):Conversation[];
export function listConversations(items:readonly Conversation[],archived?:boolean):Conversation[];
export function renameConversation(item:Conversation,label:string):Conversation;
export function touchConversation(item:Conversation,firstQuestion:string,now?:number):Conversation;
