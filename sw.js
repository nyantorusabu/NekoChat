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
			(async () => {
				try {
					const response = await fetch(request);
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
					// オフライン等でネットワーク取得に失敗した場合は、
					// index のキャッシュは使わず、常に offline を返す。
					// （index をそのまま出すと main.js が peerjs/接続待ちで
					// 半端に固まった状態になり、オフラインだと分からないため）
					return caches.match('./offline');
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
		caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)),
	);
});
