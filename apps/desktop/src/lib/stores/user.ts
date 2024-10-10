import { resetPostHog, setPostHogUser } from '$lib/analytics/posthog';
import { resetSentry, setSentryUser } from '$lib/analytics/sentry';
import { invoke } from '$lib/backend/ipc';
import { showError } from '$lib/notifications/toasts';
import { copyToClipboard } from '$lib/utils/clipboard';
import { sleep } from '$lib/utils/sleep';
import { openExternalUrl } from '$lib/utils/url';
import { type HttpClient } from '@gitbutler/shared/httpClient';
import { plainToInstance } from 'class-transformer';
import { derived, writable } from 'svelte/store';

export type LoginToken = {
	token: string;
	expires: string;
	url: string;
};

export class UserService {
	readonly loading = writable(false);

	readonly user = writable<User | undefined>(undefined, () => {
		this.refresh();
	});
	readonly error = writable();

	async refresh() {
		const userData = await invoke<User | undefined>('get_user');
		if (userData) {
			const user = plainToInstance(User, userData);
			this.user.set(user);
			setPostHogUser(user);
			setSentryUser(user);
			return user;
		}
		this.user.set(undefined);
	}
	readonly accessToken$ = derived(this.user, (user) => {
		user?.github_access_token;
	});

	constructor(private httpClient: HttpClient) {}

	async setUser(user: User | undefined) {
		if (user) await invoke('set_user', { user });
		else await this.clearUser();
		this.user.set(user);
	}

	async clearUser() {
		await invoke('delete_user');
	}

	async logout() {
		await this.clearUser();
		this.user.set(undefined);
		resetPostHog();
		resetSentry();
	}

	private async loginCommon(action: (url: string) => void): Promise<User | undefined> {
		this.logout();
		this.loading.set(true);
		try {
			// Create login token
			const token = await this.httpClient.post<LoginToken>('login/token.json');
			const url = new URL(token.url);
			url.host = this.httpClient.apiUrl.host;

			action(url.toString());

			// Assumed min time for login flow
			await sleep(4000);

			const user = await this.pollForUser(token.token);
			this.setUser(user);

			return user;
		} catch (err) {
			console.error(err);
			showError('Something went wrong', err);
		} finally {
			this.loading.set(false);
		}
	}

	async login(): Promise<User | undefined> {
		return await this.loginCommon((url) => {
			openExternalUrl(url);
		});
	}

	async loginAndCopyLink(): Promise<User | undefined> {
		return await this.loginCommon((url) => {
			setTimeout(() => {
				copyToClipboard(url);
			}, 0);
		});
	}

	async pollForUser(token: string): Promise<User | undefined> {
		let apiUser: User | null;
		for (let i = 0; i < 120; i++) {
			apiUser = await this.getLoginUser(token).catch(() => null);
			if (apiUser) {
				this.setUser(apiUser);
				return apiUser;
			}
			await sleep(1000);
		}
	}

	// TODO: Remove token from URL, we don't want that leaking into logs.
	async getLoginUser(token: string): Promise<User> {
		return await this.httpClient.get(`login/user/${token}.json`);
	}

	async getUser(token: string): Promise<User> {
		return await this.httpClient.get('user.json', { token });
	}

	async updateUser(token: string, params: { name?: string; picture?: File }): Promise<any> {
		const formData = new FormData();
		if (params.name) formData.append('name', params.name);
		if (params.picture) formData.append('avatar', params.picture);

		// Content Type must be unset for the right form-data border to be set automatically
		return await this.httpClient.put('user.json', {
			body: formData,
			headers: { 'Content-Type': undefined },
			token
		});
	}
}

export class User {
	id!: number;
	name: string | undefined;
	given_name: string | undefined;
	family_name: string | undefined;
	email!: string | undefined;
	picture!: string;
	locale!: string | undefined;
	created_at!: string;
	updated_at!: string;
	access_token!: string;
	role: string | undefined;
	supporter!: boolean;
	github_access_token: string | undefined;
	github_username: string | undefined;
}
