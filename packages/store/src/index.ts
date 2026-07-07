/**
 * @aiim/store — 持久化（PG）。首批只含加友任务存储的接口 + 内存实现。
 * ConversationStore（对话记忆·中转站权威）等在后续 change 增补。
 */
export { InMemoryFriendAddStore } from './friend-add-store';
export type { FriendAddStore, InMemoryStoreSeed } from './friend-add-store';
