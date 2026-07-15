// NekoChat Service Worker
// 役割:
//   1. オンライン時にアプリの主要ファイル（特に offline）をキャッシュしておく
//   2. オフライン時、ページ遷移（ナビゲーション）が失敗したら
//      常に offline を表示する（index のキャッシュは使わない）
//   3. オンラインに戻ったタイミング・SW起動時にキャッシュを自動で更新する

// キャッシュのバージョンを上げると、新しいキャッシュが作られ古いキャッシュは破棄される
const CACHE_VERSION = 'v2';
const CACHE_NAME = `nekochat-cache-${CACHE_VERSION}`;

// offline は「オフライン時に必ず表示できる」ことを保証しなければならない
// 最重要ファイルなので、他のファイルとは別枠で厳密に扱う（下記参照）。
const OFFLINE_URL = './offline';

// オフライン時に最低限表示・動作させたいファイル群
// （peerjs などの外部CDNはオフラインでは元々使えないため対象外）
// ※ OFFLINE_URL は下の install 処理で別途・優先的にキャッシュするため、
//   ここには含めない（二重管理による取りこぼしを防ぐ）
const PRECACHE_URLS = [
	'./',
	'./style.css',
	'./main.js',
	'./favicon.svg',
	'./manifest.webmanifest',
];

// install の cache.add() はレスポンスが !ok（4xx/5xx）だと reject する仕様を利用し、
// 「本当に取得・キャッシュできたか」を明確に判定する。
// さらに、失敗時は指数バックオフで複数回リトライし、一時的なネットワーク不調による
// 取りこぼしを防ぐ（＝ここが失敗する＝オフライン初回に確実に死ぬ、なので特に手厚くする）。
async function cachePutStrict(cache, url) {
	const req = new Request(url, { cache: 'reload' });
	const res = await fetch(req);
	if (!res || !res.ok) {
		throw new Error(`Bad response for ${url}: ${res && res.status}`);
	}
	await cache.put(req, res.clone());
	return res;
}

async function cacheOfflineWithRetry(cache, retries = 3) {
	let lastErr;
	for (let i = 0; i < retries; i++) {
		try {
			await cachePutStrict(cache, OFFLINE_URL);
			return true;
		} catch (err) {
			lastErr = err;
			// 指数バックオフ（300ms, 600ms, 1200ms...）
			await new Promise((r) => setTimeout(r, 300 * Math.pow(2, i)));
		}
	}
	console.error('Failed to precache offline page after retries:', lastErr);
	return false;
}

// stale-while-revalidate で際限なくキャッシュが増え続けないよう、
// 静的アセット用キャッシュの上限件数を設け、超えた分は古いものから削除する
const MAX_CACHE_ENTRIES = 100;

async function trimCache(cacheName, maxEntries) {
	const cache = await caches.open(cacheName);
	const keys = await cache.keys();
	if (keys.length <= maxEntries) return;
	// Cache API はキーの追加順を保持しているため、先頭＝古いものから削除する
	const excess = keys.length - maxEntries;
	for (let i = 0; i < excess; i++) {
		await cache.delete(keys[i]);
	}
}

/* ===================== install ===================== */
// インストール時に主要ファイルをまとめてキャッシュする。
// offline ページは「絶対にキャッシュされていないと困る」特別なファイルなので、
// 他の（失敗しても致命的ではない）ファイル群とは分けて、リトライ付きで確実に取得する。
self.addEventListener('install', (event) => {
	event.waitUntil(
		caches.open(CACHE_NAME).then(async (cache) => {
			// offline を最優先でキャッシュ（ここが最重要）
			await cacheOfflineWithRetry(cache);

			// それ以外は従来通り、1件失敗しても全体は失敗させない
			await Promise.all(
				PRECACHE_URLS.map((url) =>
					cache.add(url).catch((err) => {
						console.warn('Precache failed for', url, err);
					}),
				),
			);

			self.skipWaiting();
		}),
	);
});

/* ===================== activate ===================== */
// 古いバージョンのキャッシュを削除し、すぐにページを制御下に置く。
// 併せて、何らかの理由で install 時に offline のキャッシュが
// 欠落したまま activate に至ってしまった場合の保険として、再確認・再取得する。
self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) =>
				Promise.all(
					keys
						.filter(
							(key) =>
								key.startsWith('nekochat-cache-') &&
								key !== CACHE_NAME,
						)
						.map((key) => caches.delete(key)),
				),
			)
			.then(() => caches.open(CACHE_NAME))
			.then(async (cache) => {
				const has = await cache.match(OFFLINE_URL);
				if (!has) {
					console.warn(
						'offline page missing at activate, retrying precache',
					);
					await cacheOfflineWithRetry(cache);
				}
			})
			.then(() => self.clients.claim()),
	);
});

/* ===================== fetch ===================== */
// ナビゲーション（ページ読み込み）はネット優先、失敗したらキャッシュ→offline
// それ以外の静的アセットは stale-while-revalidate（即キャッシュ返却＋裏で更新）
self.addEventListener('fetch', (event) => {
	const { request } = event;

	// GET 以外（POST等）は素通しする
	if (request.method !== 'GET') return;

	// ページ遷移（HTMLナビゲーション）の場合
	if (request.mode === 'navigate') {
		event.respondWith(
			(async () => {
				const showOffline = async () => {
					// index のキャッシュは使わず、常に offline を返す。
					// （index をそのまま出すと main.js が peerjs/接続待ちで
					// 半端に固まった状態になり、オフラインだと分からないため）
					const cached = await caches.match(OFFLINE_URL);
					if (cached) return cached;
					// ここに来るのは「offline すらキャッシュされていない」
					// という異常系（install/activate のリトライも失敗した場合）。
					// caches.match が undefined を返すと respondWith(undefined) 相当になり
					// ブラウザ標準の「このサイトにアクセスできません」が出てしまうため、
					// 最終防衛ラインとして最低限のHTMLをその場で生成して返す。
					return new Response(
						'<!doctype html><html lang="ja"><head><meta charset="UTF-8">' +
							'<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
							'<title>NekoChat(Offline)</title></head>' +
							'<body style="font-family:sans-serif;padding:40px;text-align:center;color:#333">' +
							'<h2>オフラインです</h2>' +
							'<p>ネットワークに接続されていないため、ページを読み込めませんでした。</p>' +
							'<button onclick="location.reload()" style="padding:8px 20px;">再読み込み</button>' +
							'</body></html>',
						{
							status: 200,
							headers: { 'Content-Type': 'text/html; charset=UTF-8' },
						},
					);
				};

				try {
					const response = await fetch(request);
					// レスポンスは返ってきたが、実質的に失敗と同義のケースを弾く。
					// - !response.ok（4xx/5xx）: サーバーエラーやキャプティブポータル等
					// - opaqueredirect: リダイレクト先が取得できていない
					// これらをそのまま返すと壊れた画面が出るため、offline 扱いにする。
					if (!response || (!response.ok && response.type !== 'opaque')) {
						return await showOffline();
					}
					// 取得に成功したら最新のページをキャッシュへ自動更新しておく
					// （書き込み完了前にSWが終了しないよう waitUntil で保護する）
					const copy = response.clone();
					event.waitUntil(
						caches
							.open(CACHE_NAME)
							.then((cache) => cache.put(request, copy)),
					);
					return response;
				} catch {
					// オフライン等でネットワーク取得に失敗（例外）した場合
					return await showOffline();
				}
			})(),
		);
		return;
	}

	// 同一オリジンの静的アセット（css/js/svg/manifest等）
	const url = new URL(request.url);
	if (url.origin === self.location.origin) {
		// Range リクエスト（音声・動画等の部分取得）はキャッシュ対象外にし、
		// ブラウザ標準の挙動（ネットワーク直行）に任せる。
		// ※ Range 付きレスポンスを cache.put すると失敗する実装があるため。
		if (request.headers.has('range')) {
			return;
		}

		event.respondWith(
			caches.open(CACHE_NAME).then(async (cache) => {
				const cached = await cache.match(request);

				// オンラインなら裏側で最新版を取りに行きキャッシュを自動更新する
				// （書き込み完了前にSWが終了しないよう waitUntil で保護する）
				const networkFetch = fetch(request)
					.then((response) => {
						if (response && response.ok) {
							const copy = response.clone();
							event.waitUntil(
								cache
									.put(request, copy)
									.then(() => trimCache(CACHE_NAME, MAX_CACHE_ENTRIES)),
							);
						}
						return response;
					})
					.catch(() => null);

				// キャッシュがあれば即返し、なければネットワーク完了を待つ
				return cached || (await networkFetch) || cached;
			}),
		);
	}
	// 外部CDN（peerjs等）はこのSWでは扱わずブラウザ標準の挙動に任せる
});

/* ===================== message ===================== */
// ページ側から「今すぐキャッシュを更新して」と頼まれた時のための任意フック
// data は将来の拡張に備えて構造化メッセージ { type: '...' } を想定し、
// 想定外の型・値は無視することで意図しないコマンド実行を防ぐ
self.addEventListener('message', (event) => {
	const data = event.data;
	const type = typeof data === 'string' ? data : data && data.type;

	if (type !== 'update-cache') return;

	event.waitUntil(
		caches.open(CACHE_NAME).then(async (cache) => {
			await cacheOfflineWithRetry(cache);
			await Promise.all(
				PRECACHE_URLS.map((url) =>
					cache.add(url).catch((err) => {
						console.warn('Cache update failed for', url, err);
					}),
				),
			);
		}),
	);
});
