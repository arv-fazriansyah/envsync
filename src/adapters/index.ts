// Adapter base
export * from './base.js';

// Adapters
export { DotenvAdapter, createDotenvAdapter } from './dotenv.js';
export { OnePasswordAdapter, createOnePasswordAdapter } from './onepassword.js';
export { DopplerAdapter, createDopplerAdapter } from './doppler.js';
export { GitHubActionsAdapter, createGitHubActionsAdapter } from './github-actions.js';
export { VercelAdapter, createVercelAdapter } from './vercel.js';

// Register all adapters
import { adapterRegistry } from './base.js';
import { createDotenvAdapter } from './dotenv.js';
import { createOnePasswordAdapter } from './onepassword.js';
import { createDopplerAdapter } from './doppler.js';
import { createGitHubActionsAdapter } from './github-actions.js';
import { createVercelAdapter } from './vercel.js';

adapterRegistry.register('dotenv', createDotenvAdapter);
adapterRegistry.register('1password', createOnePasswordAdapter);
adapterRegistry.register('doppler', createDopplerAdapter);
adapterRegistry.register('github-actions', createGitHubActionsAdapter);
adapterRegistry.register('vercel', createVercelAdapter);

export { adapterRegistry };