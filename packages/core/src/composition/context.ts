import { AsyncLocalStorage } from 'node:async_hooks';
import type { ChatRequest } from '../session/provider.ts';
import type { RenderedPrompt } from '../prompt/index.ts';
export const turnContext = new AsyncLocalStorage<ChatRequest>();
export const promptContext = new AsyncLocalStorage<RenderedPrompt>();
