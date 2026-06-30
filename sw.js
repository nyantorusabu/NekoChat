// NekoChat Service Worker
// 役割:
//   1. オンライン時にアプリの主要ファイル（特に offline）をキャッシュしておく
//   2. オフライン時、ページ遷移（ナビゲーション）が失敗したら
//      常に offline を表示する（index のキャッシュは使わない）
//   3. オンラインに戻ったタイミング・SW起動時にキャッシュを自動で更新する

// キャッシュのバージョンを上げると、新しいキャッシュが作られ古いキャッシュは破棄される
const CACHE_VERSION = 'v1';
const CACHE_NAME = `nekochat-cache-${CACHE_VERSION}`;

// オフライン時に最低限表示・動作させたいファイル群
// （peerjs などの外部CDNはオフラインでは元々使えないため対象外）
const PRECACHE_URLS = [
	'./',
	'./offline',
	'./style.css',
	'./main.js',
	'./favicon.svg',
	'./manifest.webmanifest',
];

/* ===================== install ===================== */
// インストール時に主要ファイルをまとめてキャッシュする
self.addEventListener('install', (event) => {
	event.waitUntil(
		caches
			.open(CACHE_NAME)
			.then((cache) => cache.addAll(PRECACHE_URLS))
			.then(() => self.skipWaiting()),
	);
});

/* ===================== activate ===================== */
// 古いバージョンのキャッシュを削除し、すぐにページを制御下に置く
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
			fetch(request)
				.then((response) => {
					// 取得に成功したら最新のページをキャッシュへ自動更新しておく
					const copy = response.clone();
					caches
						.open(CACHE_NAME)
						.then((cache) => cache.put(request, copy));
					return response;
				})
				.catch(async () => {
					// オフライン等でネットワーク取得に失敗した場合は、
					// index のキャッシュは使わず、常に offline を返す。
					// （index をそのまま出すと main.js が peerjs/接続待ちで
					// 半端に固まった状態になり、オフラインだと分からないため）
					return caches.match('./offline');
				}),
		);
		return;
	}

	// 同一オリジンの静的アセット（css/js/svg/manifest等）
	const url = new URL(request.url);
	if (url.origin === self.location.origin) {
		event.respondWith(
			caches.open(CACHE_NAME).then(async (cache) => {
				const cached = await cache.match(request);

				// オンラインなら裏側で最新版を取りに行きキャッシュを自動更新する
				const networkFetch = fetch(request)
					.then((response) => {
						if (response && response.ok) {
							cache.put(request, response.clone());
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
self.addEventListener('message', (event) => {
	if (event.data === 'update-cache') {
		event.waitUntil(
			caches
				.open(CACHE_NAME)
				.then((cache) => cache.addAll(PRECACHE_URLS)),
		);
	}
});
