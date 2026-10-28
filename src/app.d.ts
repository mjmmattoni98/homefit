import type { Session, User } from 'better-auth';

// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		interface Locals {
			user?: User;
			session?: Session;
		}
		interface PageData {
			user: { name: string; email: string } | null;
			signupEnabled: boolean;
			googleHealthEnabled: boolean;
		}
		// interface Error {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
