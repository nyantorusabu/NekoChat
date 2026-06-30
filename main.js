window.addEventListener('DOMContentLoaded', () => {
	/* ===================== utilities ===================== */

	function sdbm(str) {
		let h = 0;
		for (let i = 0; i < str.length; i++)
			h = str.charCodeAt(i) + (h << 6) + (h << 16) - h;
		return (h >>> 0).toString(16);
	}
	function hostPeerId(roomId) {
		return 'nekochat-host-' + sdbm('h::' + roomId);
	}
	function userPeerId(roomId, myUid, suffix) {
		return (
			'nekochat-user-' +
			sdbm('u::' + roomId + '::' + myUid) +
			(suffix ? '-' + suffix : '')
		);
	}
	function uid() {
		return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
	}
	// Issue 6: 各バイトをゼロパディングして出力長を均一にし、
	// エントロピーの損失を防ぐ（旧実装は可変長で衝突確率が上がる恐れがあった）
	function randomRoomId() {
		const a = new Uint8Array(9);
		crypto.getRandomValues(a);
		// 各バイトを base36 2桁固定でエンコード → 16文字の均一なID
		return Array.from(a)
			.map((b) => b.toString(36).padStart(2, '0'))
			.join('')
			.slice(0, 16);
	}
	function fmtTime(ts) {
		return new Date(ts).toLocaleString('ja-JP', {
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
		});
	}
	function dayKey(ts) {
		return new Date(ts).toDateString();
	}
	function toast(text) {
		const t = document.getElementById('toast');
		t.textContent = text;
		t.classList.add('show');
		clearTimeout(toast._h);
		toast._h = setTimeout(() => t.classList.remove('show'), 2200);
	}
	/* ---------- showAlert / showConfirm ---------- */
	function _openDialog({ title, message, buttons }) {
		const ov  = document.getElementById('ovDialog');
		const ttl = document.getElementById('dialogTitle');
		const msg = document.getElementById('dialogMessage');
		const act = document.getElementById('dialogActions');

		ttl.textContent = title || '';
		msg.textContent = message || '';
		msg.style.display = message ? '' : 'none';
		act.innerHTML = '';

		buttons.forEach(({ label, cls, resolve }) => {
			const btn = document.createElement('button');
			btn.textContent = label;
			if (cls) btn.className = cls;
			btn.addEventListener('click', () => {
				ov.classList.remove('show');
				resolve();
			});
			act.appendChild(btn);
		});

		const onKey = (e) => {
			if (e.key !== 'Escape') return;
			document.removeEventListener('keydown', onKey);
			const last = act.lastElementChild;
			if (last) last.click();
		};
		document.addEventListener('keydown', onKey);

		ov.classList.add('show');
		requestAnimationFrame(() => act.firstElementChild?.focus());
	}

	function showAlert(message, title = '') {
		return new Promise((resolve) => {
			_openDialog({
				title: title || '通知',
				message,
				buttons: [{ label: 'OK', cls: 'primary', resolve }],
			});
		});
	}

	function showConfirm(message, title = '') {
		return new Promise((resolve) => {
			_openDialog({
				title: title || '確認',
				message,
				buttons: [
					{ label: 'キャンセル', cls: '', resolve: () => resolve(false) },
					{ label: 'OK',         cls: 'primary', resolve: () => resolve(true) },
				],
			});
		});
	}
	/* ---------------------------------------------- */

	function bytesToSize(b) {
		if (b < 1024) return b + ' B';
		if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
		return (b / 1024 / 1024).toFixed(1) + ' MB';
	}
	function b64FromBuf(buf) {
		const bytes = new Uint8Array(buf);
		let bin = '';
		for (let i = 0; i < bytes.length; i++)
			bin += String.fromCharCode(bytes[i]);
		return btoa(bin);
	}
	function bufFromB64(b64) {
		const bin = atob(b64);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		return bytes.buffer;
	}

	const FILE_DB_NAME = 'nekochat_files_db';
	const FILE_DB_STORE = 'files';
	const FILE_CHUNK_SIZE = 128 * 1024;
	const FILE_ACCEPT_DELAY_MS = 220;
	const FILE_REQUEST_SELECT_MS = 1200;
	// V-02: ファイル受信サイズの上限（1GB）とチャンク数の上限
	// これを超えるファイルは acceptIncomingFile / handleIncomingFileChunk で拒否する
	const FILE_MAX_SIZE_BYTES = 1024 * 1024 * 1024; // 1GB
	const FILE_MAX_TOTAL_CHUNKS = Math.ceil(FILE_MAX_SIZE_BYTES / FILE_CHUNK_SIZE) + 1; // ~8193

	function requestToPromise(req) {
		return new Promise((resolve, reject) => {
			req.onsuccess = () => resolve(req.result);
			req.onerror = () =>
				reject(req.error || new Error('IndexedDB request failed'));
		});
	}

	function openFileDb() {
		return new Promise((resolve, reject) => {
			const req = indexedDB.open(FILE_DB_NAME, 1);
			req.onupgradeneeded = () => {
				const db = req.result;
				if (!db.objectStoreNames.contains(FILE_DB_STORE)) {
					db.createObjectStore(FILE_DB_STORE, {
						keyPath: 'fileId',
					});
				}
			};
			req.onsuccess = () => resolve(req.result);
			req.onerror = () =>
				reject(req.error || new Error('IndexedDB open failed'));
		});
	}

	function txDone(tx) {
		return new Promise((resolve, reject) => {
			tx.oncomplete = () => resolve();
			tx.onerror = () =>
				reject(tx.error || new Error('IndexedDB transaction failed'));
			tx.onabort = () =>
				reject(tx.error || new Error('IndexedDB transaction aborted'));
		});
	}

	async function putFileRecord(record) {
		const db = await openFileDb();
		try {
			const tx = db.transaction(FILE_DB_STORE, 'readwrite');
			tx.objectStore(FILE_DB_STORE).put(record);
			await txDone(tx);
		} finally {
			db.close();
		}
	}

	async function getFileRecord(fileId) {
		if (!fileId) return null;
		const db = await openFileDb();
		try {
			const tx = db.transaction(FILE_DB_STORE, 'readonly');
			const req = tx.objectStore(FILE_DB_STORE).get(fileId);
			const row = await requestToPromise(req);
			await txDone(tx).catch(() => {});
			return row || null;
		} finally {
			db.close();
		}
	}

	async function deleteFileRecord(fileId) {
		if (!fileId) return;
		const db = await openFileDb();
		try {
			const tx = db.transaction(FILE_DB_STORE, 'readwrite');
			tx.objectStore(FILE_DB_STORE).delete(fileId);
			await txDone(tx);
		} finally {
			db.close();
		}
	}

	async function cleanupRoomFiles(roomId) {
		if (!roomId) return;
		const db = await openFileDb();
		try {
			const tx = db.transaction(FILE_DB_STORE, 'readwrite');
			const store = tx.objectStore(FILE_DB_STORE);
			const allReq = store.getAll();
			const all = await new Promise((resolve, reject) => {
				allReq.onsuccess = () => resolve(allReq.result || []);
				allReq.onerror = () => reject(allReq.error);
			});
			for (const rec of all) {
				if (rec && rec.roomId === roomId) {
					store.delete(rec.fileId);
				}
			}
			await txDone(tx);
		} finally {
			db.close();
		}
		// メモリ上の転送状態もクリア（該当ルーム分）
		for (const [key, st] of Array.from(App.fileTransfers.entries())) {
			if (
				st &&
				((st.file && st.file.roomId === roomId) || key.includes(roomId))
			) {
				if (st.requestTimer) clearTimeout(st.requestTimer);
				App.fileTransfers.delete(key);
			}
		}
	}

	async function digestHex(buffer) {
		const digest = await crypto.subtle.digest('SHA-256', buffer);
		return Array.from(new Uint8Array(digest))
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');
	}

	async function hashBlobHex(blob) {
		return digestHex(await blob.arrayBuffer());
	}

	function estimateConnectionKbps(uid) {
		const stats = App.transferStats.get(uid);
		if (stats && stats.speedKbps > 0) return Math.round(stats.speedKbps);
		const conn =
			navigator.connection ||
			navigator.mozConnection ||
			navigator.webkitConnection;
		if (conn && typeof conn.downlink === 'number' && conn.downlink > 0) {
			return Math.max(1, Math.round(conn.downlink * 1000));
		}
		const active = App.fileTransfers.get(uid);
		if (active && active.speedKbps > 0) return Math.round(active.speedKbps);
		return 0;
	}

	function makeFileId() {
		if (crypto.randomUUID) return crypto.randomUUID();
		return 'file_' + uid();
	}

	function currentFileState(fileId, targetUid = '') {
		const key = targetUid ? `${fileId}::${targetUid}` : fileId;
		let state = App.fileTransfers.get(key);
		if (!state) {
			state = {
				key,
				fileId,
				targetUid: targetUid || '',
				status: 'idle',
				receivedBytes: 0,
				sentBytes: 0,
				totalBytes: 0,
				chunks: new Map(),
				offers: [],
			};
			App.fileTransfers.set(key, state);
		}
		return state;
	}

	function updateTransferStats(uid, bytes, startedAt) {
		if (!uid || !startedAt || !bytes) return;
		const elapsed = Math.max(1, Date.now() - startedAt);
		const speedKbps = (bytes * 8) / elapsed;
		App.transferStats.set(uid, {
			bytes,
			startedAt,
			speedKbps,
			updatedAt: Date.now(),
		});
	}

	function cloneFileMeta(file) {
		if (!file) return null;
		return {
			fileId: file.fileId || '',
			name: file.name || '',
			mime: file.mime || '',
			size: Number(file.size || 0),
			hash: file.hash || '',
			chunkSize: Number(file.chunkSize || FILE_CHUNK_SIZE),
			senderUid: file.senderUid || '',
			createdAt: file.createdAt || Date.now(),
		};
	}

	// normalizeFileMeta は cloneFileMeta と同一のため統合済み
	const normalizeFileMeta = cloneFileMeta;

	function hasLocalFileRecord(fileId) {
		return getFileRecord(fileId)
			.then(Boolean)
			.catch(() => false);
	}

	function safeBytes(n) {
		const x = Number(n || 0);
		return Number.isFinite(x) ? x : 0;
	}

	function mediaVolumeKey(uid, kind) {
		return `${kind || 'voice'}::${uid || ''}`;
	}
	function getMediaVolume(uid, kind) {
		const key = mediaVolumeKey(uid, kind);
		const v = App.mediaVolumes.get(key);
		if (typeof v === 'number' && Number.isFinite(v))
			return Math.max(0, Math.min(1, v));
		return 1;
	}
	function setMediaVolume(uid, kind, value) {
		const key = mediaVolumeKey(uid, kind);
		const v = Math.max(0, Math.min(1, Number(value)));
		App.mediaVolumes.set(key, v);
		let el =
			kind === 'screen'
				? App.screenMediaEls.get(uid)
				: App.mediaEls.get(uid);
		if (el) {
			el.volume = v;
		} else if (
			kind === 'screen' &&
			uid === Identity.id &&
			App.screenStream
		) {
			// Self screen share: apply to any video elements currently playing the screenStream
			document
				.querySelectorAll(
					'#featuredVideo video, #participantList video',
				)
				.forEach((vid) => {
					if (vid.srcObject === App.screenStream) {
						vid.volume = v;
					}
				});
		}
	}
	function applyMediaVolume(el, uid, kind) {
		if (!el) return;
		el.volume = getMediaVolume(uid, kind);
		if (kind === 'screen') {
			el.muted = App.screenMuted.has(uid) || App.mutedUsers.has(uid);
		} else {
			el.muted = App.voiceMuted.has(uid) || App.mutedUsers.has(uid);
		}
	}

	/* ---- 通信状況に応じた自動バッファ調整 (jitter buffer) ---- */
	function startMediaBufferMonitor() {
		if (App.bufferMonitorTimer) clearInterval(App.bufferMonitorTimer);
		// delta計算用: SSRC -> { packetsLost, packetsReceived, emaScore } の前回値を保持
		if (!App._bufStats) App._bufStats = new Map();
		// 警告クールダウン: 頻繁なトースト表示を防ぐ
		if (!App._bufWarnCooldown) App._bufWarnCooldown = 0;
		// EMAの平滑化係数 (0〜1 で大きいほど最新値を重視)
		const EMA_ALPHA = 0.25;
		App.bufferMonitorTimer = setInterval(() => {
			if (!App.voiceConns.size && !App.screenConns.size) return;

			let anyPoor = false;
			let allExcellent = true;
			let activePCs = 0;
			let completedCount = 0;

			const checkConns = (connsMap) => {
				connsMap.forEach((call, remoteUid) => {
					const pc = call.peerConnection;
					if (!pc) return;
					activePCs++;
					pc.getStats()
						.then((stats) => {
							let jitterSum = 0,
								deltaLossSum = 0,
								count = 0;
							stats.forEach((report) => {
								if (report.type === 'inbound-rtp') {
									// jitter は秒単位なのでそのまま使う
									jitterSum += report.jitter || 0;
									if (
										report.packetsLost != null &&
										report.packetsReceived != null
									) {
										const key =
											remoteUid +
											':' +
											(report.ssrc || '0');
										const prev = App._bufStats.get(key) || {
											packetsLost: 0,
											packetsReceived: 0,
											emaScore: 1,
										};
										const dLost = Math.max(
											0,
											report.packetsLost -
												prev.packetsLost,
										);
										const dRecv = Math.max(
											0,
											report.packetsReceived -
												prev.packetsReceived,
										);
										const dTotal = dLost + dRecv;
										const rawLoss =
											dTotal > 0 ? dLost / dTotal : 0;
										// EMAでスコア履歴を平滑化（急激な変動を抑える）
										const rawScore = Math.max(
											0,
											1 - Math.min(1, rawLoss * 10),
										);
										const emaScore =
											EMA_ALPHA * rawScore +
											(1 - EMA_ALPHA) * prev.emaScore;
										App._bufStats.set(key, {
											packetsLost: report.packetsLost,
											packetsReceived:
												report.packetsReceived,
											emaScore,
										});
										deltaLossSum += 1 - emaScore;
									}
									count++;
								}
							});
							const avgJitter = count ? jitterSum / count : 0;
							const avgLossScore = count ? deltaLossSum / count : 0;
							// 合成スコア: loss EMA と jitter を加重合成 (0~1)
							// jitter閾値: 20ms以上で影響が出始め、60ms超で最悪スコア
							const jitterScore = Math.max(
								0,
								1 - Math.min(1, avgJitter / 0.06),
							);
							const score = Math.max(
								0,
								Math.min(1, (1 - avgLossScore) * 0.65 + jitterScore * 0.35),
							);

							// バッファ範囲: 20ms（良好）〜 600ms（劣悪）
							// 通常の音声通話では300ms以上は遅延として知覚されるため上限を抑える
							const targetSec = Math.max(
								0.02,
								Math.min(0.6, 0.02 + (1 - score) * 0.58),
							);

							try {
								pc.getReceivers().forEach((r) => {
									if (!r.track) return;
									// jitterBufferTarget が使えるブラウザ（Chrome 87+）
									if (typeof r.jitterBufferTarget === 'number') {
										r.jitterBufferTarget = targetSec;
									}
									// playoutDelayHint が使えるブラウザ（Safari / Firefox）
									if (typeof r.playoutDelayHint === 'number') {
										r.playoutDelayHint = targetSec;
									}
								});
							} catch (e) {}

							if (score < 0.4) {
								anyPoor = true;
							}
							if (score < 0.85) {
								allExcellent = false;
							}
						})
						.catch(() => {})
						.finally(() => {
							completedCount++;
							if (completedCount === activePCs && activePCs > 0) {
								const now = Date.now();
								// すべての接続のチェックが終わったらトースト表示を判断
								// クールダウン中は重複トーストを抑制（10秒）
								if (anyPoor) {
									if (
										!App._bufferWarned &&
										now - App._bufWarnCooldown > 10000
									) {
										App._bufferWarned = true;
										App._bufWarnCooldown = now;
										toast('接続状況が不安定になっています');
									}
								} else if (allExcellent) {
									if (App._bufferWarned) {
										App._bufferWarned = false;
										App._bufWarnCooldown = now;
										toast('接続状況が回復しました');
									}
								}
							}
						});
				});
			};
			checkConns(App.voiceConns);
			checkConns(App.screenConns);
		}, 2500);
	}

	// speaking クラスの付け外しだけを行う軽量な差分更新。
	// DOM を再構築せずクラスを操作するだけなので映像の点滅が起きない。
	function updateSpeakingUI(uid, kind, active) {
		// featuredVideo
		const fv = document.getElementById('featuredVideo');
		if (fv && fv.dataset.uid === uid && fv.dataset.kind === kind) {
			fv.classList.toggle('speaking', active);
		}
		// participantList 内の対応する行
		const list = document.getElementById('participantList');
		if (list) {
			list.querySelectorAll('.pRow').forEach((row) => {
				if (row.dataset.uid === uid && row.dataset.kind === kind) {
					row.classList.toggle('speaking', active);
				}
			});
		}
	}

	function setSpeakingFlag(uid, kind, active) {
		const key = mediaVolumeKey(uid, kind);
		if (App.speakingState.get(key) === !!active) return;
		App.speakingState.set(key, !!active);
		// DOM を再構築せず speaking クラスだけ差分更新して映像の点滅を防ぐ
		updateSpeakingUI(uid, kind, !!active);
		if (uid === Identity.id) {
			distributeSys({
				t: 'sys',
				sub: 'voice-speaking',
				payload: {
					uid: Identity.id,
					kind: kind,
					active: !!active,
				},
			});
		}
	}
	function cleanupSpeakingMonitor(uid, kind) {
		const key = mediaVolumeKey(uid, kind);
		const mon = App.speakingMonitors.get(key);
		if (mon) {
			clearInterval(mon.timer);
			try {
				mon.ctx && mon.ctx.close && mon.ctx.close();
			} catch (e) {}
			App.speakingMonitors.delete(key);
		}
		App.speakingState.delete(key);
	}
	function attachSpeakingMonitor(uid, stream, kind) {
		if (uid !== Identity.id) return; // リモートユーザーの音声解析は行わない（シグナリングで発話通知を受け取るため）
		if (
			!uid ||
			!stream ||
			!stream.getAudioTracks ||
			!stream.getAudioTracks().length
		)
			return;
		const key = mediaVolumeKey(uid, kind);
		cleanupSpeakingMonitor(uid, kind);
		const Ctx = window.AudioContext || window.webkitAudioContext;
		if (!Ctx) return;
		let ctx;
		try {
			ctx = new Ctx();
		} catch (e) {
			return;
		}
		let source, analyser;
		const startMonitor = () => {
			try {
				source = ctx.createMediaStreamSource(stream);
				analyser = ctx.createAnalyser();
				// fftSize=256でCPU負荷を下げる（発話検出に周波数分解能は不要）
				analyser.fftSize = 256;
				source.connect(analyser);
			} catch (e) {
				try {
					ctx.close();
				} catch (e2) {}
				return;
			}
			const data = new Uint8Array(analyser.fftSize);
			let lastActive = 0;
			const sample = () => {
				try {
					// AudioContextがsuspendedのままなら再resume試行
					if (ctx.state === 'suspended') {
						ctx.resume().catch(() => {});
						return;
					}
					analyser.getByteTimeDomainData(data);
					let sum = 0;
					for (let i = 0; i < data.length; i++) {
						const v = (data[i] - 128) / 128;
						sum += v * v;
					}
					const rms = Math.sqrt(sum / data.length);
					let active = rms > 0.03;
					if (active) lastActive = Date.now();
					if (!active && Date.now() - lastActive < 180) active = true;
					setSpeakingFlag(uid, kind, active);
				} catch (e) {}
			};
			const timer = setInterval(sample, 120);
			sample();
			App.speakingMonitors.set(key, {
				ctx,
				source,
				analyser,
				timer,
			});
		};
		// モバイルではAudioContextがsuspendedで始まる場合があるため
		// resume()の完了を待ってからモニターを開始する
		const resumePromise = ctx.resume ? ctx.resume() : Promise.resolve();
		resumePromise.then(startMonitor).catch(startMonitor);
	}

	function isUserSpeaking(uid, kind) {
		return !!App.speakingState.get(mediaVolumeKey(uid, kind));
	}
	function canPreviewFile(file) {
		if (!file || !file.mime) return false;
		// V-01: safeMimeType で正規化した後にプレビュー可否を判定する。
		// 申告MIMEが許可リスト外の場合は safeMimeType が
		// 'application/octet-stream' を返すため自動的に false になる。
		return isSafeMimePreviewable(safeMimeType(file.mime));
	}
	function openFilePreview(m) {
		const file = m && m.file ? m.file : null;
		if (!file || !canPreviewFile(file)) return;
		const overlay = document.getElementById('ovFilePreview');
		const title = document.getElementById('filePreviewTitle');
		const meta = document.getElementById('filePreviewMeta');
		const stage = document.getElementById('filePreviewStage');
		const dl = document.getElementById('filePreviewDownload');
		if (!overlay || !title || !meta || !stage || !dl) return;
		stage.innerHTML = '';
		const state = file.fileId ? App.fileTransfers.get(file.fileId) : null;
		const setupDownload = async () => {
			let url = null;
			let ownedUrl = false;
			if (file.fileId) {
				url = await loadStoredFileObjectUrl(file.fileId, file);
				ownedUrl = !!url;
			}
			if (!url && (file.objectUrl || state?.objectUrl)) {
				url = file.objectUrl || state?.objectUrl || null;
				ownedUrl = false;
			}
			return { url, ownedUrl };
		};
		const key = file.fileId || m.id || uid();
		if (App.currentFilePreviewUrl) {
			try {
				URL.revokeObjectURL(App.currentFilePreviewUrl);
			} catch (e) {}
			App.currentFilePreviewUrl = null;
		}
		const loadStage = async () => {
			const loaded = await setupDownload();
			const url = loaded?.url;
			if (!url) {
				stage.textContent = 'プレビューを表示できません';
				return;
			}
			App.currentFilePreviewUrl = loaded?.ownedUrl ? url : null;
			if (file.mime.startsWith('image/')) {
				const img = document.createElement('img');
				img.src = url;
				img.alt = file.name || 'image';
				stage.appendChild(img);
			} else if (file.mime.startsWith('video/')) {
				const video = document.createElement('video');
				video.src = url;
				video.controls = true;
				video.autoplay = false;
				video.playsInline = true;
				stage.appendChild(video);
			} else if (file.mime.startsWith('audio/')) {
				const audio = document.createElement('audio');
				audio.src = url;
				audio.controls = true;
				stage.appendChild(audio);
			}
		};
		title.textContent = file.name || 'ファイル';
		meta.textContent = `${bytesToSize(file.size || 0)} / ${file.mime || 'unknown'} / ${fileStatusText(state, file)}`;
		dl.onclick = async () => {
			const loaded = await setupDownload();
			const url = loaded?.url;
			if (!url) return;
			const a = document.createElement('a');
			a.href = url;
			a.download = safeFileName(file.name); // Issue 3
			a.click();
		};
		overlay.dataset.fileKey = key;
		openOverlay('ovFilePreview');
		loadStage();
	}
	function closeFilePreview() {
		closeOverlay('ovFilePreview');
	}
	function openMediaFullscreen(payload) {
		if (!payload || !payload.stream) return;
		const overlay = document.getElementById('ovMediaFullscreen');
		const stage = document.getElementById('mediaFullscreenStage');
		const title = document.getElementById('mediaFullscreenTitle');
		if (!overlay || !stage || !title) return;
		stage.innerHTML = '';
		const media =
			payload.kind === 'audio'
				? document.createElement('audio')
				: document.createElement('video');
		media.srcObject = payload.stream;
		if (media.tagName === 'VIDEO') {
			media.autoplay = true;
			media.playsInline = true;
			media.controls = false;
			// 音声を二重再生しないよう常にミュート（音声はバックグラウンド要素で再生されます）
			media.muted = true;
			media.setAttribute('playsinline', 'true');
		} else {
			media.controls = true;
		}
		stage.appendChild(media);
		title.textContent = payload.label || '全画面表示';
		overlay.classList.add('show');
		document.body.dataset.mediaFullscreen = 'open';
		App.mediaFullscreen = payload;
		backStack.push({ type: 'mediaFullscreen' });
		history.pushState({ nk: 'mediaFullscreen' }, '');
		setTimeout(() => {
			try {
				media.play && media.play();
			} catch (e) {}
		}, 0);
	}
	function closeMediaFullscreen(fromHistory = false) {
		const overlay = document.getElementById('ovMediaFullscreen');
		if (!overlay || !overlay.classList.contains('show')) return;
		overlay.classList.remove('show');
		document.body.dataset.mediaFullscreen = '';
		App.mediaFullscreen = null;
		const stage = document.getElementById('mediaFullscreenStage');
		if (stage) stage.innerHTML = '';
		if (!fromHistory) {
			const idx = backStack.findIndex((item) => item.type === 'mediaFullscreen');
			if (idx !== -1) {
				backStack.splice(idx, 1);
				isInternalBack = true;
				history.back();
			}
		}
	}
	function hashColorFromUid(uid) {
		let h = 0;
		const s = uid || '?';
		for (let i = 0; i < s.length; i++) h = s.charCodeAt(i) + ((h << 5) - h);
		const hue = Math.abs(h) % 360;
		return `hsl(${hue} 48% 38%)`;
	}
	function initialsFromName(name) {
		const s = (name || '').trim();
		if (!s) return '?';
		return Array.from(s).slice(0, 2).join('').toUpperCase();
	}

	/* ===================== layout state ===================== */

	let isMobile = window.innerWidth <= 768;

	// 縮小PCUI: PCだがサイドバーが重なる幅（769〜999px）
	function isCompactPC() {
		return !isMobile && window.innerWidth < 1000;
	}

	function setSidebarOpen(open, { fromHistory = false } = {}) {
		const wasOpen = document.body.dataset.sidebar === 'open';
		document.body.dataset.sidebar = open ? 'open' : 'closed';
		if (isMobile) {
			if (!open && wasOpen && !fromHistory) {
				backStack.push({ type: 'sidebarClosed' });
				history.pushState({ nk: 'sidebarClosed' }, '');
			} else if (open && !wasOpen && !fromHistory) {
				const idx = backStack.findIndex((item) => item.type === 'sidebarClosed');
				if (idx !== -1) {
					backStack.splice(idx, 1);
					isInternalBack = true;
					history.back();
				}
			}
		}
	}

	function setChatOpen(open, { fromHistory = false } = {}) {
		const wasOpen = document.body.dataset.chat === 'open';
		document.body.dataset.chat = open ? 'open' : 'closed';
		const btn = document.getElementById('vcChatBtn');
		if (btn) btn.classList.toggle('active', open);
		const isVC = !!App.localStream;
		if (isMobile && isVC) {
			if (open && !wasOpen && !fromHistory) {
				backStack.push({ type: 'chat' });
				history.pushState({ nk: 'chat' }, '');
			} else if (!open && wasOpen && !fromHistory) {
				const idx = backStack.findIndex((item) => item.type === 'chat');
				if (idx !== -1) {
					backStack.splice(idx, 1);
					isInternalBack = true;
					history.back();
				}
			}
		}
	}

	function toggleSidebar() {
		const isOpen = document.body.dataset.sidebar === 'open';
		setSidebarOpen(!isOpen);
	}

	function toggleChat() {
		const isOpen = document.body.dataset.chat === 'open';
		setChatOpen(!isOpen);
	}

	let _resizeTimer = null;
	let _lastInnerWidth = window.innerWidth;
	window.addEventListener('resize', () => {
		clearTimeout(_resizeTimer);
		_resizeTimer = setTimeout(() => {
			const w = window.innerWidth;
			const currentIsMobile = w <= 768;

			if (isMobile !== currentIsMobile) {
				isMobile = currentIsMobile;
				if (isMobile) {
					setSidebarOpen(false);
					setChatOpen(false);
				} else {
					// PCに戻ったとき: 縮小PCUIでもサイドバーは開いたままにする
					setSidebarOpen(true);
					setChatOpen(w >= 850);
				}
			} else if (!isMobile) {
				// PCUI時の自動閉じる処理
				// 縮小PC（769〜999px）に入るときはサイドバーを閉じない
				if (_lastInnerWidth >= 850 && w < 850) {
					setChatOpen(false);
				}
			}
			_lastInnerWidth = w;
		}, 150);
	});

	/* ===================== simple mode check ===================== */
	function isSimpleMode() {
		// 正規クエリパラメータ優先、ハッシュ疑似パラメータは後方互換
		return (
			new URLSearchParams(location.search).has('simple') ||
			new URLSearchParams(location.hash.replace(/^#/, '')).has('simple')
		);
	}
	function isVoiceMode() {
		return (
			new URLSearchParams(location.search).has('voice') ||
			new URLSearchParams(location.hash.replace(/^#/, '')).has('voice')
		);
	}
	// simple/voiceは値を持たないフラグパラメータとして扱う。
	// URLSearchParamsのset(key, '')は必ず "key=" という空の=付き文字列になってしまうため、
	// "&voice=" のような不格好な表記を避けるべく手組みでクエリ文字列を生成する。
	// roomId未指定時は r パラメータを含めない（ルーム未参加時のURL用）。
	function buildModeSearch(roomId) {
		const parts = [];
		if (roomId) parts.push('r=' + encodeURIComponent(roomId));
		if (isSimpleMode()) parts.push('simple');
		if (isVoiceMode()) parts.push('voice');
		return parts.length ? '?' + parts.join('&') : '';
	}
	// voiceパラメータでボイスチャットモーダルを開いた後、URLから自動削除する
	// （再読み込みやルーム再入で勝手にモーダルが再オープンしないようにするため）
	// buildModeSearchと同じくフラグ形式（=なし）で再構成し、空の "simple=" 等が
	// 紛れ込まないようにする。
	function clearVoiceModeParam() {
		if (!isVoiceMode()) return;
		const roomId = new URLSearchParams(location.search).get('r');
		const newSearch = (() => {
			const parts = [];
			if (roomId) parts.push('r=' + encodeURIComponent(roomId));
			if (isSimpleMode()) parts.push('simple');
			return parts.length ? '?' + parts.join('&') : '';
		})();
		const hp = new URLSearchParams(location.hash.replace(/^#/, ''));
		hp.delete('voice');
		const hStr = hp.toString();
		const newHash = hStr ? '#' + hStr : '';
		if (location.search !== newSearch || location.hash !== newHash) {
			history.replaceState(
				history.state,
				'',
				location.pathname + newSearch + newHash,
			);
		}
	}

	function applySimpleMode() {
		const sidebar = document.getElementById('sidebar');
		const sidebarToggleBtn = document.getElementById('sidebarToggleBtn');
		if (isSimpleMode()) {
			sidebar.style.display = 'none';
			if (sidebarToggleBtn) sidebarToggleBtn.style.display = 'none';
			document.getElementById('header').style.paddingLeft = '16px';
			document.getElementById('userPopover').style.left = '16px';
		} else {
			sidebar.style.display = '';
			if (sidebarToggleBtn) sidebarToggleBtn.style.display = '';
			document.getElementById('header').style.paddingLeft = '52px';
			document.getElementById('userPopover').style.left = '52px';
		}
	}

	/* ===================== peer stun config ===================== */
	const STUN_CONFIG = {
		config: {
			iceServers: [
				{ urls: 'stun:stun.l.google.com:19302' },
				{ urls: 'stun:stun1.l.google.com:19302' },
				{ urls: 'stun:stun2.l.google.com:19302' },
				{ urls: 'stun:stun3.l.google.com:19302' },
				{ urls: 'stun:stun4.l.google.com:19302' },
			],
		},
	};

	/* ===================== identity ===================== */
	const Identity = {
		id: null,
		privateKey: null,
		publicKey: null,
		pubJwk: null,
	};

	async function hashPub(pubJwk) {
		const data = new TextEncoder().encode(JSON.stringify(pubJwk));
		const digest = await crypto.subtle.digest('SHA-256', data);
		return Array.from(new Uint8Array(digest))
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('')
			.slice(0, 16);
	}
	async function ensureIdentity() {
		const raw = localStorage.getItem('nekochat_identity');
		if (raw) {
			try {
				const obj = JSON.parse(raw);
				Identity.id = obj.id;
				Identity.pubJwk = obj.pubJwk;
				Identity.privateKey = await crypto.subtle.importKey(
					'jwk',
					obj.privJwk,
					{ name: 'ECDSA', namedCurve: 'P-256' },
					false,
					['sign'],
				);
				Identity.publicKey = await crypto.subtle.importKey(
					'jwk',
					obj.pubJwk,
					{ name: 'ECDSA', namedCurve: 'P-256' },
					true,
					['verify'],
				);
				return;
			} catch (e) {
				console.warn('identity破損のため再生成します', e);
				localStorage.removeItem('nekochat_identity');
			}
		}
		const kp = await crypto.subtle.generateKey(
			{ name: 'ECDSA', namedCurve: 'P-256' },
			true,
			['sign', 'verify'],
		);
		const pubJwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
		const privJwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
		const id = await hashPub(pubJwk);
		localStorage.setItem(
			'nekochat_identity',
			JSON.stringify({ id, pubJwk, privJwk }),
		);
		Identity.id = id;
		Identity.pubJwk = pubJwk;
		Identity.privateKey = kp.privateKey;
		Identity.publicKey = kp.publicKey;
	}
	function canonical(o) {
		// 署名検証の安定化のため、キー順序をソートした正規化JSONを返す
		if (o === null || typeof o !== 'object') return JSON.stringify(o);
		if (Array.isArray(o)) return '[' + o.map(canonical).join(',') + ']';
		const keys = Object.keys(o).sort();
		return (
			'{' +
			keys
				.map((k) => JSON.stringify(k) + ':' + canonical(o[k]))
				.join(',') +
			'}'
		);
	}
	async function signPayload(signable) {
		const data = new TextEncoder().encode(canonical(signable));
		const sig = await crypto.subtle.sign(
			{ name: 'ECDSA', hash: 'SHA-256' },
			Identity.privateKey,
			data,
		);
		return b64FromBuf(sig);
	}
	async function verifyPayload(signable, sigB64, pubJwk, expectUid, skipTimestampCheck = false) {
		try {
			if ((await hashPub(pubJwk)) !== expectUid) return false;
			// クロスルーム再送攻撃（リプレイ）を防ぐため、ルームIDが一致するか検証
			if (signable.roomId && signable.roomId !== App.roomId) return false;
			// リプレイ攻撃対策: タイムスタンプが現在時刻から±90秒以内のもののみ有効
			// （以前は過去5分・未来10分を許容していたが、ウィンドウを大幅に縮小）
			if (!skipTimestampCheck) {
				const now = Date.now();
				if (
					signable.ts &&
					(signable.ts > now + 90 * 1000 || signable.ts < now - 90 * 1000)
				)
					return false;
			}
			const key = await crypto.subtle.importKey(
				'jwk',
				pubJwk,
				{ name: 'ECDSA', namedCurve: 'P-256' },
				false,
				['verify'],
			);
			const data = new TextEncoder().encode(canonical(signable));
			return await crypto.subtle.verify(
				{ name: 'ECDSA', hash: 'SHA-256' },
				key,
				bufFromB64(sigB64),
				data,
			);
		} catch (e) {
			return false;
		}
	}

	async function sendTargeted(payload, toUid) {
		if (App.isHost) {
			const targetPeers = Array.from(
				App.userConnections.get(toUid) || [],
			);
			const targetPeerId = targetPeers.find(
				(peerId) => App.conns.has(peerId) && App.conns.get(peerId).open,
			);
			if (!targetPeerId) return false;
			const conn = App.conns.get(targetPeerId);
			if (!conn || !conn.open) return false;
			conn.send({ t: 'data', from: Identity.id, payload });
			return true;
		}
		if (!App.hostConn || !App.hostConn.open) return false;
		App.hostConn.send({ t: 'relay', toUid, payload });
		return true;
	}

	function mergeFileTransferState(fileId, patch, targetUid = '') {
		const s = currentFileState(fileId, targetUid);
		Object.assign(s, patch || {});
		App.fileTransfers.set(
			s.key || (targetUid ? `${fileId}::${targetUid}` : fileId),
			s,
		);
		return s;
	}

	function fileProgressPct(state) {
		const total = safeBytes(state?.totalBytes || state?.total || 0);
		const done = safeBytes(state?.receivedBytes || state?.sentBytes || 0);
		if (!total) return 0;
		return Math.min(100, Math.max(0, (done / total) * 100));
	}

	function fileStatusText(state, file) {
		if (!state && file && file.fileId && file.transferStatus === 'ready')
			return '保存済み';
		const status = state?.status || file?.transferStatus || 'ready';
		const isSender =
			state?.currentSenderUid === Identity.id ||
			file?.senderUid === Identity.id;
		if (status === 'receiving') return '受信中';
		if (status === 'sending') return '送信中';
		if (status === 'waiting') return '待機中';
		if (status === 'requesting') return '転送要求中';
		if (status === 'offered') return isSender ? '送信待ち' : '受信待ち';
		if (status === 'rejected') return '拒否';
		if (status === 'paused') return '一時停止';
		if (status === 'complete' || status === 'ready')
			return isSender ? '送信完了' : '受信完了';
		if (status === 'missing') return '未取得';
		return String(status);
	}

	async function storeReceivedFile(fileId, fileInfo, blob) {
		await putFileRecord({
			fileId,
			roomId: App.roomId,
			ownerUid: fileInfo?.senderUid || '',
			name: fileInfo?.name || 'download.bin',
			// V-01: 保存するMIMEも正規化する（ロード時に危険なタイプが使われないよう）
			mime: safeMimeType(fileInfo?.mime),
			size: safeBytes(fileInfo?.size || blob.size),
			hash: fileInfo?.hash || '',
			blob,
			updatedAt: new Date().toISOString(),
		});
	}

	async function loadStoredFileObjectUrl(fileId, fileInfo) {
		const rec = await getFileRecord(fileId);
		if (!rec || !rec.blob) return null;
		// V-01: Blob を再構築する際も safeMimeType で正規化する。
		// IndexedDB に保存済みの rec.mime は storeReceivedFile で正規化済みだが、
		// 古いバージョンで保存されたレコードへの後方互換のためここでも適用する。
		const safeMime = safeMimeType(fileInfo?.mime || rec.mime);
		const blob =
			rec.blob instanceof Blob
				? rec.blob
				: new Blob([rec.blob], {
						type: safeMime,
					});
		const url = URL.createObjectURL(blob);
		App._objectUrls.add(url); // Issue 10: リーク追跡
		return url;
	}

	function hydrateFilePreview(file, refresh = true) {
		if (!file || !file.fileId || file.objectUrl || file.__hydrating) return;
		file.__hydrating = true;
		getFileRecord(file.fileId)
			.then((rec) => {
				if (rec && rec.blob && !file.objectUrl) {
					// V-01: Blob 再構築時も safeMimeType で正規化する
					const safeMime = safeMimeType(file.mime || rec.mime);
					const blob =
						rec.blob instanceof Blob
							? rec.blob
							: new Blob([rec.blob], {
									type: safeMime,
								});
					file.objectUrl = URL.createObjectURL(blob);
					App._objectUrls.add(file.objectUrl); // Issue 10: リーク追跡
					file.transferStatus = 'complete';
					file.receivedBytes = blob.size;
					file.totalBytes = blob.size;

					// ローカルに実体がある場合は state にも反映（リロード時の受信済み判定を確実にする）
					const st = currentFileState(file.fileId);
					st.status = 'complete';
					st.objectUrl = file.objectUrl;
					st.receivedBytes = blob.size;
					st.totalBytes = blob.size;

					if (refresh) {
						renderLog();
					} else if (
						file.fileId &&
						typeof updateFileMessageEl === 'function'
					) {
						updateFileMessageEl(file.fileId);
					}
				}
			})
			.catch(() => {})
			.finally(() => {
				file.__hydrating = false;
			});
	}

	function renderFileTransferBox(body, m, file, state) {
		// 上のファイル情報（renderFileBodyのwrap）はそのまま残し、ここでは重複するヘッダを省略。
		// 進捗・操作ボタンのみ追加表示する（上だけにするための修正）
		const box = document.createElement('div');
		box.style.display = 'grid';
		box.style.gap = '6px';

		const showProgress =
			!state ||
			!['complete', 'ready'].includes(String(state.status || ''));
		if (showProgress) {
			const barWrap = document.createElement('div');
			barWrap.style.height = '6px';
			barWrap.style.border = '1px solid var(--line)';
			barWrap.style.borderRadius = '999px';
			barWrap.style.overflow = 'hidden';
			barWrap.style.background = '#fff';
			const bar = document.createElement('div');
			bar.style.height = '100%';
			bar.style.width = `${fileProgressPct(state)}%`;
			bar.style.background = 'var(--accent)';
			barWrap.appendChild(bar);
			box.appendChild(barWrap);
		}

		const sub = document.createElement('div');
		sub.className = 'hint';
		sub.textContent =
			state?.hint ||
			(state?.status === 'receiving'
				? `${bytesToSize(state.receivedBytes || 0)} / ${bytesToSize(file.size)}`
				: state?.status === 'sending'
					? `${bytesToSize(state.sentBytes || 0)} / ${bytesToSize(file.size)}`
					: '');
		box.appendChild(sub);

		const actions = document.createElement('div');
		actions.style.display = 'flex';
		actions.style.flexWrap = 'wrap';
		actions.style.gap = '6px';

		const canDownload = !!file.fileId;
		if (state?.status === 'receiving') {
			const rejectBtn = document.createElement('button');
			rejectBtn.textContent = '拒否';
			rejectBtn.className = 'danger';
			rejectBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				rejectIncomingFile(file.fileId);
			});
			actions.appendChild(rejectBtn);
		}
		if (
			!canDownload ||
			state?.status === 'missing' ||
			state?.status === 'requesting'
		) {
			const reqBtn = document.createElement('button');
			reqBtn.textContent = '転送をリクエスト';
			reqBtn.onclick = () => requestFileRelay(file, m);
			actions.appendChild(reqBtn);
		}
		if (
			canDownload &&
			(state?.status === 'complete' ||
				state?.status === 'ready' ||
				state?.status === 'sending' ||
				state?.status === 'received')
		) {
			const dlBtn = document.createElement('button');
			dlBtn.textContent = 'ダウンロード';
			dlBtn.onclick = async () => {
				let url = file.objectUrl;
				if (!url)
					url = await loadStoredFileObjectUrl(file.fileId, file);
				if (url) {
					const a = document.createElement('a');
					a.href = url;
					a.download = safeFileName(file.name); // Issue 3
					a.click();
				}
			};
			actions.appendChild(dlBtn);
		}
		box.appendChild(actions);
		body.appendChild(box);
	}

	function scheduleAutoAccept(file) {
		const state = currentFileState(file.fileId);
		if (state.autoAcceptTimer) clearTimeout(state.autoAcceptTimer);
		state.autoAcceptTimer = setTimeout(() => {
			if (state.status === 'rejected' || state.status === 'complete')
				return;
			acceptIncomingFile(file, state);
		}, FILE_ACCEPT_DELAY_MS);
	}

	async function acceptIncomingFile(file, state) {
		if (!file || !file.fileId) return;
		const s = currentFileState(file.fileId);
		if (
			s.status === 'rejected' ||
			s.status === 'complete' ||
			s.status === 'receiving'
		)
			return;
		// V-02: 受信前にファイルサイズを確認してDoSを防ぐ
		const declaredSize = safeBytes(file.size);
		if (declaredSize > FILE_MAX_SIZE_BYTES) {
			console.warn(
				'[FILE] acceptIncomingFile: ファイルサイズ上限超過のため拒否',
				{ fileId: file.fileId, size: declaredSize, limit: FILE_MAX_SIZE_BYTES },
			);
			s.status = 'rejected';
			App.fileTransfers.set(file.fileId, s);
			toast('ファイルサイズが上限（1GB）を超えているため受信を拒否しました');
			return;
		}
		s.status = 'receiving';
		s.totalBytes = safeBytes(file.size);
		s.file = cloneFileMeta(file);
		App.fileTransfers.set(file.fileId, s);
		const ts = Date.now();
		const speedKbps = estimateConnectionKbps(Identity.id);
		const signable = {
			k: 'file-control',
			action: 'accept',
			fileId: file.fileId,
			roomId: App.roomId,
			targetUid: file.senderUid,
			recipientUid: Identity.id,
			preferredUid: Identity.id,
			acceptedAt: ts,
			speedKbps,
			ts,
		};
		const sig = await signPayload(signable);
		await sendTargeted(
			{
				k: 'file-control',
				action: 'accept',
				fileId: file.fileId,
				roomId: App.roomId,
				targetUid: file.senderUid,
				recipientUid: Identity.id,
				preferredUid: Identity.id,
				acceptedAt: ts,
				speedKbps,
				ts,
				uid: Identity.id,
				pub: Identity.pubJwk,
				sig,
			},
			file.senderUid,
		);
	}

	async function rejectIncomingFile(fileId) {
		const state = currentFileState(fileId);
		state.status = 'rejected';
		App.fileTransfers.set(state.key || fileId, state);
		renderLog();
		if (state.currentSenderUid) {
			const ts = Date.now();
			const signable = {
				k: 'file-control',
				action: 'reject',
				fileId,
				roomId: App.roomId,
				targetUid: null,
				recipientUid: Identity.id,
				preferredUid: null,
				acceptedAt: null,
				speedKbps: 0,
				ts,
			};
			const sig = await signPayload(signable);
			await sendTargeted(
				{
					k: 'file-control',
					action: 'reject',
					fileId,
					roomId: App.roomId,
					targetUid: null,
					recipientUid: Identity.id,
					preferredUid: null,
					acceptedAt: null,
					speedKbps: 0,
					ts,
					uid: Identity.id,
					pub: Identity.pubJwk,
					sig,
				},
				state.currentSenderUid,
			);
		}
	}

	async function requestFileRelay(file, message) {
		if (!file || !file.fileId) return;
		const state = mergeFileTransferState(file.fileId, {
			status: 'requesting',
			file: cloneFileMeta(file),
			offers: [],
			selectedUid: null,
			requestedAt: Date.now(),
			requestedBySelf: true,
		});
		state.requestTimer && clearTimeout(state.requestTimer);
		state.requestTimer = setTimeout(
			() => selectBestRelay(file.fileId),
			FILE_REQUEST_SELECT_MS,
		);
		const knownPeers = Array.from(App.users.values()).filter(
			(u) => u.uid !== Identity.id,
		);
		if (!knownPeers.length) {
			toast('転送できるユーザーがいません');
			return;
		}
		// 元の送信者も含めてリクエストを送る（送信者しかファイルを持っていないケースがほとんどだから）
		for (const peer of knownPeers) {
			await sendTargeted(
				{
					k: 'file-request',
					fileId: file.fileId,
					roomId: App.roomId,
					requesterUid: Identity.id,
					requesterName: Profile.name,
					file: cloneFileMeta(file),
					ts: Date.now(),
				},
				peer.uid,
			);
		}
		toast('転送リクエストを送信しました');
	}

	async function selectBestRelay(fileId) {
		console.log('[FILE] selectBestRelay 開始 fileId=', fileId);
		const state = currentFileState(fileId);
		if (!state || state.selectedUid) {
			console.log(
				'[FILE] selectBestRelay: スキップ(state=',
				!!state,
				'selectedUid=',
				state?.selectedUid,
				')',
			);
			return;
		}
		const offers = (state.offers || [])
			.slice()
			.sort((a, b) => (b.speedKbps || 0) - (a.speedKbps || 0));
		const best = offers[0];
		if (!best) {
			console.warn('[FILE] selectBestRelay: offerなし→missing');
			state.status = 'missing';
			renderLog();
			return;
		}
		console.log('[FILE] selectBestRelay: 選択 best=', best.uid);
		state.selectedUid = best.uid;
		state.status = 'waiting';
		const ts = Date.now();
		const signable = {
			k: 'file-select',
			fileId,
			roomId: App.roomId,
			requesterUid: Identity.id,
			selectedUid: best.uid,
			selectedSpeedKbps: best.speedKbps || 0,
			ts,
		};
		const sig = await signPayload(signable);
		await sendTargeted(
			{
				k: 'file-select',
				fileId,
				roomId: App.roomId,
				requesterUid: Identity.id,
				selectedUid: best.uid,
				selectedSpeedKbps: best.speedKbps || 0,
				ts,
				uid: Identity.id,
				pub: Identity.pubJwk,
				sig,
			},
			best.uid,
		);
	}

	const _inFlightFileSends = new Set();
	const _chunkPrepCache = new Map(); // fileId -> Promise<Array<{buf,chunkB64,chunkHash}>>
	async function _getPreparedChunks(fileId, blob) {
		if (_chunkPrepCache.has(fileId)) return _chunkPrepCache.get(fileId);
		const promise = (async () => {
			const total = Math.ceil(blob.size / FILE_CHUNK_SIZE) || 1;
			const chunks = new Array(total);
			for (let seq = 0; seq < total; seq++) {
				const slice = blob.slice(
					seq * FILE_CHUNK_SIZE,
					Math.min(blob.size, (seq + 1) * FILE_CHUNK_SIZE),
				);
				const buf = await slice.arrayBuffer();
				const [chunkHash, chunkB64] = await Promise.all([
					digestHex(buf),
					Promise.resolve(b64FromBuf(buf)),
				]);
				chunks[seq] = { chunkHash, chunkB64 };
			}
			return chunks;
		})();
		_chunkPrepCache.set(fileId, promise);
		return promise;
	}
	async function startSendingFileToUid(file, targetUid, reason = 'receive') {
		if (!file || !file.fileId || !targetUid) return;
		const sendKey = file.fileId + '::' + targetUid;
		if (_inFlightFileSends.has(sendKey)) return;
		_inFlightFileSends.add(sendKey);
		try {
			await _doSendFileToUid(file, targetUid, reason);
		} finally {
			_inFlightFileSends.delete(sendKey);
		}
	}
	async function _doSendFileToUid(file, targetUid, reason = 'receive') {
		console.log(
			'[FILE] _doSendFileToUid開始 fileId=',
			file?.fileId,
			'targetUid=',
			targetUid,
			'reason=',
			reason,
		);
		const rec = await getFileRecord(file.fileId);
		if (!rec || !rec.blob) {
			console.warn(
				'[FILE] _doSendFileToUid: DBにファイルなし fileId=',
				file.fileId,
				'rec=',
				rec,
			);
			toast('送信元ファイルが見つかりません');
			return;
		}
		const blob =
			rec.blob instanceof Blob
				? rec.blob
				: new Blob([rec.blob], {
						type:
							file.mime || rec.mime || 'application/octet-stream',
					});
		const state = mergeFileTransferState(file.fileId, {
			status: 'sending',
			currentTargetUid: targetUid,
			currentSenderUid: Identity.id,
			totalBytes: blob.size,
			file: cloneFileMeta(file),
		});
		if (!state.startedAt) state.startedAt = Date.now();
		state.targetCount = (state.targetCount || 0) + 1;
		state.completedTargets = state.completedTargets || new Set();
		state.perTargetSentBytes = state.perTargetSentBytes || {};
		state.perTargetTotalBytes = state.perTargetTotalBytes || {};
		state.perTargetSentBytes[targetUid] = 0;
		state.perTargetTotalBytes[targetUid] = blob.size;
		const updateAggregateSent = () => {
			const sentVals = Object.values(state.perTargetSentBytes || {});
			const totalVals = Object.values(state.perTargetTotalBytes || {});
			state.sentBytes = sentVals.reduce((a, b) => a + b, 0);
			state.totalBytes = totalVals.reduce((a, b) => a + b, 0);
		};
		updateAggregateSent();
		const preparedChunks = await _getPreparedChunks(file.fileId, blob);
		const total = preparedChunks.length;
		let lastUiUpdate = 0;
		const UI_THROTTLE_MS = 120;
		for (let seq = 0; seq < total; seq++) {
			if (state.status === 'rejected') break;
			const { chunkHash, chunkB64 } = preparedChunks[seq];
			const ts = Date.now();
			const signable = {
				k: 'file-chunk',
				fileId: file.fileId,
				roomId: App.roomId,
				fromUid: Identity.id,
				toUid: targetUid,
				seq,
				total,
				chunkHash,
				ts,
			};
			const sig = await signPayload(signable);
			await sendTargeted(
				{
					k: 'file-chunk',
					fileId: file.fileId,
					roomId: App.roomId,
					fromUid: Identity.id,
					toUid: targetUid,
					seq,
					total,
					chunkHash,
					chunkB64,
					ts,
					pub: Identity.pubJwk,
					sig,
				},
				targetUid,
			);
			state.perTargetSentBytes[targetUid] = Math.min(
				blob.size,
				(seq + 1) * FILE_CHUNK_SIZE,
			);
			updateAggregateSent();
			updateTransferStats(
				targetUid,
				state.perTargetSentBytes[targetUid],
				state.startedAt,
			);
			const now = Date.now();
			if (seq === total - 1 || now - lastUiUpdate >= UI_THROTTLE_MS) {
				lastUiUpdate = now;
				if (!updateFileMessageEl(file.fileId)) renderLog();
			}
		}
		const finalTs = Date.now();
		const completeSignable = {
			k: 'file-complete',
			fileId: file.fileId,
			roomId: App.roomId,
			fromUid: Identity.id,
			toUid: targetUid,
			totalBytes: blob.size,
			hash: file.hash || rec.hash || '',
			ts: finalTs,
		};
		const completeSig = await signPayload(completeSignable);
		await sendTargeted(
			{
				k: 'file-complete',
				fileId: file.fileId,
				roomId: App.roomId,
				fromUid: Identity.id,
				toUid: targetUid,
				totalBytes: blob.size,
				hash: file.hash || rec.hash || '',
				ts: finalTs,
				pub: Identity.pubJwk,
				sig: completeSig,
			},
			targetUid,
		);
		state.completedTargets.add(targetUid);
		if (state.completedTargets.size >= state.targetCount) {
			state.status = 'complete';
			state.sentBytes = blob.size;
			state.totalBytes = blob.size;
			state.file = Object.assign({}, state.file || {}, {
				transferStatus: 'complete',
				sentBytes: blob.size,
				totalBytes: blob.size,
			});
			_chunkPrepCache.delete(file.fileId);
		}
		App.fileTransfers.set(file.fileId, state);
		if (!updateFileMessageEl(file.fileId)) renderLog();
	}

	async function handleIncomingFileChunk(payload) {
		if (!payload || !payload.fileId || !payload.chunkB64) return;
		const file = payload.file || findMessageByFileId(payload.fileId)?.file;
		const state = currentFileState(payload.fileId);
		if (!file) {
			console.warn(
				'[FILE] handleIncomingFileChunk: ファイルメッセージ未発見 fileId=',
				payload.fileId,
				'seq=',
				payload.seq,
			);
			return;
		}
		const ok = await verifyPayload(
			{
				k: 'file-chunk',
				fileId: payload.fileId,
				roomId: App.roomId,
				fromUid: payload.fromUid,
				toUid: payload.toUid,
				seq: payload.seq,
				total: payload.total,
				chunkHash: payload.chunkHash,
				ts: payload.ts,
			},
			payload.sig,
			payload.pub,
			payload.fromUid,
		);
		if (!ok) {
			console.warn('file-chunk署名検証失敗');
			return;
		}
		if (payload.toUid && payload.toUid !== Identity.id) return;
		if (
			typeof payload.seq !== 'number' ||
			payload.seq < 0 ||
			(payload.total != null &&
				// V-02: チャンク総数の上限を FILE_MAX_TOTAL_CHUNKS に絞る（旧: 1e7 = 1.28TB相当）
				(payload.seq >= payload.total || payload.total > FILE_MAX_TOTAL_CHUNKS))
		) {
			console.warn('不正なchunk seq/totalを拒否');
			return;
		}
		// V-02: 受信中にも累積サイズが上限を超えていないか確認する
		const expectedTotalBytes = safeBytes(file.size);
		if (expectedTotalBytes > FILE_MAX_SIZE_BYTES) {
			console.warn(
				'[FILE] handleIncomingFileChunk: ファイルサイズ上限超過のため中断',
				{ fileId: payload.fileId, size: expectedTotalBytes },
			);
			state.status = 'rejected';
			state.chunks = new Map();
			App.fileTransfers.set(payload.fileId, state);
			if (!updateFileMessageEl(payload.fileId)) renderLog();
			return;
		}
		const buf = bufFromB64(payload.chunkB64);
		const actual = await digestHex(buf);
		if (actual !== payload.chunkHash) {
			console.warn('chunk hash mismatch');
			return;
		}
		state.totalBytes = safeBytes(file.size);
		state.chunks = state.chunks || new Map();
		state.chunks.set(payload.seq, buf);
		state.receivedBytes = Math.min(
			state.totalBytes,
			(state.receivedBytes || 0) + buf.byteLength,
		);
		state.status = 'receiving';
		App.fileTransfers.set(payload.fileId, state);
		const msg = findMessageByFileId(payload.fileId);
		if (msg && msg.file) {
			msg.file.transferStatus = 'receiving';
			msg.file.receivedBytes = state.receivedBytes;
			msg.file.totalBytes = state.totalBytes;
		}
		if (!updateFileMessageEl(payload.fileId)) renderLog();
		if (payload.total != null && state.chunks.size >= payload.total) {
			const buffers = Array.from(state.chunks.keys())
				.sort((a, b) => a - b)
				.map((k) => state.chunks.get(k));
			// V-01: 申告MIMEを safeMimeType で正規化してから Blob を構築する。
			// 攻撃者が text/html 等を申告しても 'application/octet-stream' に
			// 強制変換されるため、プレビュー要素での意図しない実行を防ぐ。
			const resolvedMime = safeMimeType(file.mime);
			const blob = new Blob(buffers, {
				type: resolvedMime,
			});
			const finalHash = await hashBlobHex(blob);
			if (file.hash && finalHash !== file.hash) {
				console.warn('file hash mismatch');
				state.status = 'missing';
				state.chunks = new Map();
				state.receivedBytes = 0;
				App.fileTransfers.set(payload.fileId, state);
				if (msg && msg.file) {
					msg.file.transferStatus = 'missing';
					msg.file.receivedBytes = 0;
				}
				if (!updateFileMessageEl(payload.fileId)) renderLog();
				return;
			}
			await storeReceivedFile(file.fileId, file, blob);
			const objectUrl = URL.createObjectURL(blob);
			App._objectUrls.add(objectUrl); // Issue 10: リーク追跡
			if (msg && msg.file) {
				msg.file.objectUrl = objectUrl;
				msg.file.transferStatus = 'complete';
				msg.file.receivedBytes = blob.size;
				msg.file.totalBytes = blob.size;
			}
			state.status = 'complete';
			state.objectUrl = objectUrl;
			state.receivedBytes = blob.size;
			state.totalBytes = blob.size;
			state.file = Object.assign({}, state.file || {}, {
				transferStatus: 'complete',
				receivedBytes: blob.size,
				totalBytes: blob.size,
			});
			App.fileTransfers.set(payload.fileId, state);
			persistIfNeeded();
			if (!updateFileMessageEl(payload.fileId)) renderLog();
			// 転送リクエスト経由で受け取った場合のみトーストを表示
			// （プッシュ転送や自分が送ったファイルは通知不要）
			const recvState = App.fileTransfers.get(payload.fileId);
			if (
				recvState &&
				recvState.requestedBySelf &&
				file.senderUid !== Identity.id
			) {
				toast(`${file.name} を受信しました`);
			}
		}
	}

	async function respondToFileRequest(payload) {
		const file = payload?.file || null;
		if (!file || !file.fileId) {
			console.warn(
				'[FILE] respondToFileRequest: payloadにfileなし',
				payload,
			);
			return;
		}
		const have = await getFileRecord(file.fileId);
		if (!have || !have.blob) {
			console.warn(
				'[FILE] respondToFileRequest: DBにfile未保存 fileId=',
				file.fileId,
				'have=',
				have,
			);
			return;
		}
		const speedKbps = estimateConnectionKbps(Identity.id) || 0;
		const ts = Date.now();
		const signable = {
			k: 'file-offer',
			fileId: file.fileId,
			roomId: App.roomId,
			requesterUid: payload.requesterUid,
			uid: Identity.id,
			speedKbps,
			hasFile: true,
			ts,
		};
		const sig = await signPayload(signable);
		await sendTargeted(
			{
				k: 'file-offer',
				fileId: file.fileId,
				roomId: App.roomId,
				requesterUid: payload.requesterUid,
				uid: Identity.id,
				speedKbps,
				hasFile: true,
				ts,
				pub: Identity.pubJwk,
				sig,
			},
			payload.requesterUid,
		);
	}

	async function handleFileRequest(payload) {
		console.log('[FILE] handleFileRequest受信', payload);
		if (!payload?.fileId || payload.requesterUid === Identity.id) return;
		const file = payload.file || findMessageByFileId(payload.fileId)?.file;
		if (!file || !file.fileId) {
			console.warn(
				'[FILE] handleFileRequest: ファイルメッセージ見つからず fileId=',
				payload.fileId,
			);
			return;
		}
		// この時点で payload.requesterUid !== Identity.id は確定済み（先頭のガード参照）
		await respondToFileRequest(payload);
	}

	async function handleFileOffer(payload) {
		console.log('[FILE] handleFileOffer受信', payload);
		if (!payload?.fileId || payload.requesterUid !== Identity.id) {
			console.log(
				'[FILE] handleFileOffer: 自分宛てでないためスキップ requesterUid=',
				payload?.requesterUid,
				'myId=',
				Identity.id,
			);
			return;
		}
		if (!payload.pub || !payload.sig || !payload.uid) {
			console.warn('[FILE] handleFileOffer: pub/sig/uid欠如');
			return;
		}
		const ok = await verifyPayload(
			{
				k: 'file-offer',
				fileId: payload.fileId,
				roomId: App.roomId,
				requesterUid: payload.requesterUid,
				uid: payload.uid,
				speedKbps: Number(payload.speedKbps || 0),
				hasFile: !!payload.hasFile,
				ts: payload.ts,
			},
			payload.sig,
			payload.pub,
			payload.uid,
		);
		if (!ok) {
			console.warn(
				'[FILE] handleFileOffer: 署名検証失敗 uid=',
				payload.uid,
			);
			return;
		}
		const state = currentFileState(payload.fileId);
		state.offers = state.offers || [];
		state.offers.push({
			uid: payload.uid,
			speedKbps: Number(payload.speedKbps || 0),
			ts: payload.ts,
		});
		console.log(
			'[FILE] handleFileOffer: offer追加 uid=',
			payload.uid,
			'state.offers=',
			state.offers.length,
		);
		state.status = 'requesting';
		state.file = state.file || {};
		App.fileTransfers.set(payload.fileId, state);
		clearTimeout(state.requestTimer);
		state.requestTimer = setTimeout(
			() => selectBestRelay(payload.fileId),
			FILE_REQUEST_SELECT_MS,
		);
		renderLog();
	}

	async function handleFileSelect(payload) {
		console.log('[FILE] handleFileSelect受信', payload);
		if (!payload?.fileId) return;
		if (payload.selectedUid !== Identity.id) {
			console.log(
				'[FILE] handleFileSelect: 自分がselectedUidでないためスキップ selectedUid=',
				payload.selectedUid,
				'myId=',
				Identity.id,
			);
			return;
		}
		if (!payload.pub || !payload.sig || !payload.uid) {
			console.warn('[FILE] handleFileSelect: pub/sig/uid欠如');
			return;
		}
		const ok = await verifyPayload(
			{
				k: 'file-select',
				fileId: payload.fileId,
				roomId: App.roomId,
				requesterUid: payload.requesterUid,
				selectedUid: payload.selectedUid,
				selectedSpeedKbps: Number(payload.selectedSpeedKbps || 0),
				ts: payload.ts,
			},
			payload.sig,
			payload.pub,
			payload.uid,
		);
		if (!ok) {
			console.warn(
				'[FILE] handleFileSelect: 署名検証失敗 uid=',
				payload.uid,
			);
			return;
		}
		const file = findMessageByFileId(payload.fileId)?.file;
		if (!file) {
			console.warn(
				'[FILE] handleFileSelect: ファイルメッセージ見つからず fileId=',
				payload.fileId,
			);
			return;
		}
		console.log(
			'[FILE] handleFileSelect: startSendingFileToUid開始 requesterUid=',
			payload.requesterUid,
		);
		await startSendingFileToUid(file, payload.requesterUid, 'relay');
	}

	async function handleFileComplete(payload) {
		if (!payload?.fileId) return;
		if (!payload.pub || !payload.sig || !payload.uid) return;
		const ok = await verifyPayload(
			{
				k: 'file-complete',
				fileId: payload.fileId,
				roomId: App.roomId,
				fromUid: payload.fromUid,
				toUid: payload.toUid,
				totalBytes: Number(payload.totalBytes || 0),
				hash: payload.hash || '',
				ts: payload.ts,
			},
			payload.sig,
			payload.pub,
			payload.uid,
		);
		if (!ok) return;
		const state = currentFileState(payload.fileId);
		state.status = 'complete';
		state.hint = '転送完了';
		App.fileTransfers.set(payload.fileId, state);
		renderLog();
	}

	async function handleFileControl(payload) {
		if (!payload?.action || !payload.fileId) return;
		if (!payload.pub || !payload.sig || !payload.uid) return;
		const ok = await verifyPayload(
			{
				k: 'file-control',
				action: payload.action,
				fileId: payload.fileId,
				roomId: App.roomId,
				targetUid: payload.targetUid || null,
				recipientUid: payload.recipientUid || null,
				preferredUid: payload.preferredUid || null,
				acceptedAt: payload.acceptedAt || null,
				speedKbps: Number(payload.speedKbps || 0),
				ts: payload.ts,
			},
			payload.sig,
			payload.pub,
			payload.uid,
		);
		if (!ok) return;
		if (payload.action === 'accept' && payload.targetUid === Identity.id) {
			const file = findMessageByFileId(payload.fileId)?.file;
			if (file)
				await startSendingFileToUid(
					file,
					payload.recipientUid || payload.uid,
					'upload',
				);
			return;
		}
		if (payload.action === 'reject' && payload.targetUid === Identity.id) {
			const state = currentFileState(payload.fileId);
			state.status = 'rejected';
			App.fileTransfers.set(payload.fileId, state);
			renderLog();
			return;
		}
	}

	/* ===================== profile ===================== */

	const Profile = { name: '', image: null, uid: null };
	function loadProfile() {
		const raw = localStorage.getItem('nekochat_profile');
		if (!raw) return;
		try {
			Object.assign(Profile, JSON.parse(raw));
		} catch (e) {
			console.warn('profile破損のため初期化します', e);
			localStorage.removeItem('nekochat_profile');
		}
	}
	function saveProfile() {
		try {
			const toSave = { name: Profile.name, image: Profile.image };
			localStorage.setItem('nekochat_profile', JSON.stringify(toSave));
		} catch (e) {
			// Issue 7: ストレージ容量不足を検知してユーザーに通知する
			if (
				e instanceof DOMException &&
				(e.name === 'QuotaExceededError' ||
					e.name === 'NS_ERROR_DOM_QUOTA_REACHED')
			) {
				toast(
					'ストレージ容量が不足しています。プロファイルを保存できませんでした',
				);
			}
		}
		// デバイスユーザーリストにも反映（自分自身の最新情報）
		UserStore.upsertSelf();
	}

	function loadUserSettings() {
		try {
			const nickRaw = localStorage.getItem('nekochat_nicknames');
			if (nickRaw) {
				const obj = JSON.parse(nickRaw);
				App.userNicknames = new Map(Object.entries(obj));
			}
			const muteRaw = localStorage.getItem('nekochat_muted');
			if (muteRaw) App.mutedUsers = new Set(JSON.parse(muteRaw));
		} catch (e) {
			console.warn('user settings load error', e);
		}
	}
	function saveUserSettings() {
		try {
			const nickObj = Object.fromEntries(App.userNicknames);
			localStorage.setItem('nekochat_nicknames', JSON.stringify(nickObj));
			localStorage.setItem(
				'nekochat_muted',
				JSON.stringify(Array.from(App.mutedUsers)),
			);
			// ミュート状態の変更をバックグラウンドの音声再生要素に即座に反映する
			App.mediaEls.forEach((el, remoteUid) => {
				applyMediaVolume(el, remoteUid, 'voice');
			});
			App.screenMediaEls.forEach((el, remoteUid) => {
				applyMediaVolume(el, remoteUid, 'screen');
			});
		} catch (e) {}
	}

	// V-01: 受信ファイルの申告MIMEタイプを安全な値に正規化する。
	// ピアから送られた file.mime は署名対象に含まれるが、
	// 実際の Blob の内容との照合は行われないため、
	// プレビュー・保存時に使う MIME 型を許可リスト方式で絞り込む。
	// - 画像/動画/音声: 既知の安全なサブタイプのみ許可
	// - それ以外: 'application/octet-stream' にフォールバック（ダウンロード専用扱い）
	// text/html, text/javascript 等のスクリプト実行可能タイプは意図的に除外する。
	const ALLOWED_MIME_MAP = {
		'image/jpeg': true, 'image/png': true, 'image/gif': true,
		'image/webp': true, 'image/bmp': true, 'image/tiff': true,
		'video/mp4': true, 'video/webm': true, 'video/ogg': true,
		'video/quicktime': true, 'video/x-matroska': true,
		'audio/mpeg': true, 'audio/ogg': true, 'audio/wav': true,
		'audio/webm': true, 'audio/aac': true, 'audio/flac': true,
		'audio/x-m4a': true, 'audio/mp4': true,
		'application/pdf': true,
		'application/zip': true, 'application/x-zip-compressed': true,
		'text/plain': true, 'text/csv': true,
	};
	function safeMimeType(mime) {
		if (!mime || typeof mime !== 'string') return 'application/octet-stream';
		const lower = mime.toLowerCase().trim();
		if (ALLOWED_MIME_MAP[lower]) return lower;
		// 許可リスト外は強制的にダウンロード専用MIMEに変換（text/html等のXSS源を無効化）
		return 'application/octet-stream';
	}
	// 受信MIMEがプレビュー可能かどうかの判定（safeMimeType通過後に使う）
	function isSafeMimePreviewable(mime) {
		if (!mime) return false;
		return /^(image\/(jpeg|png|gif|webp|bmp|tiff)|video\/(mp4|webm|ogg|quicktime|x-matroska)|audio\/(mpeg|ogg|wav|webm|aac|flac|x-m4a|mp4))$/.test(mime.toLowerCase());
	}

	// Issue 1 & 9: image フィールドの Data URL を厳密に検証し、
	// javascript: 等の危険なスキームを拒否する
	function safeImageSrc(val) {
		if (!val || typeof val !== 'string') return null;
		// data:image/(jpeg|png|gif|webp|svg+xml は拒否) のみ許可
		// svg は XSS を含む可能性があるため除外する
		if (
			/^data:image\/(jpeg|png|gif|webp);base64,[A-Za-z0-9+/]+=*$/.test(
				val,
			)
		)
			return val;
		return null;
	}

	// Issue 3: ファイル名から OS / ブラウザに危険な文字を除去し、
	// パストラバーサルや誤解を招くファイル名を防ぐ
	function safeFileName(name, fallback) {
		fallback = fallback || 'download.bin';
		if (!name || typeof name !== 'string') return fallback;
		// パス区切り文字・OS 予約文字・制御文字を除去
		const sanitized = name
			.replace(/[/\\:*?"<>|]/g, '_') // OS 予約文字
			.replace(/[\x00-\x1f\x7f]/g, '') // 制御文字
			.replace(/^\.+/, '_') // 先頭のドット（隠しファイル化防止）
			.trim()
			.slice(0, 255); // ファイル名長の上限
		return sanitized || fallback;
	}

	function applyAvatarEl(el, p) {
		el.innerHTML = '';
		el.style.background = '';
		const safeSrc = p && p.image ? safeImageSrc(p.image) : null;
		if (safeSrc) {
			const img = document.createElement('img');
			img.src = safeSrc;
			img.alt = '';
			el.appendChild(img);
		} else {
			const displayName = p ? p.name : '?';
			// 背景色はuidを参照することで名前変更で色が変わらないようにする
			// uidがない場合（プレビュー等）は名前にフォールバック
			const colorKey = p && p.uid ? p.uid : displayName;
			el.textContent = initialsFromName(displayName);
			el.style.background = hashColorFromUid(colorKey);
		}
	}

	function handleImagePick(file) {
		if (!file || !file.type.startsWith('image/')) return;
		const img = new Image();
		const reader = new FileReader();
		reader.onload = () => {
			img.onload = () => {
				const size = 128;
				const canvas = document.createElement('canvas');
				canvas.width = size;
				canvas.height = size;
				const ctx = canvas.getContext('2d');
				const side = Math.min(img.width, img.height);
				const sx = (img.width - side) / 2,
					sy = (img.height - side) / 2;
				ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
				const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
				if (dataUrl.length > 220000) {
					toast('画像が大きすぎます。別の画像を選んでください');
					return;
				}
				Profile.image = dataUrl;
				applyAvatarEl(
					document.getElementById('pfAvatarPreview'),
					Profile,
				);
			};
			img.src = reader.result;
		};
		reader.readAsDataURL(file);
	}

	/* ===================== social store ===================== */

	/* ===================== room store ===================== */

	const RoomStore = {
		listKey: 'nekochat_rooms',
		msgKey(roomId) {
			return 'nekochat_msgs_' + roomId;
		},
		list() {
			try {
				return JSON.parse(localStorage.getItem(this.listKey) || '[]');
			} catch (e) {
				return [];
			}
		},
		upsert(meta) {
			const list = this.list().filter((r) => r.id !== meta.id);
			list.unshift(meta);
			localStorage.setItem(
				this.listKey,
				JSON.stringify(list.slice(0, 40)),
			);
		},
		remove(roomId) {
			localStorage.setItem(
				this.listKey,
				JSON.stringify(this.list().filter((r) => r.id !== roomId)),
			);
			localStorage.removeItem(this.msgKey(roomId));
			localStorage.removeItem(this.memberKey(roomId));
		},
		memberKey(roomId) {
			return 'nekochat_members_' + roomId;
		},
		loadMembers(roomId) {
			try {
				return JSON.parse(
					localStorage.getItem(this.memberKey(roomId)) || '[]',
				);
			} catch (e) {
				return [];
			}
		},
		saveMembers(roomId, members) {
			try {
				const slim = (members || [])
					.map((m) => {
						if (!m || !m.uid) return null;
						return {
							uid: m.uid,
							name: m.name || '',
							image: m.image || null,
						};
					})
					.filter(Boolean);
				localStorage.setItem(
					this.memberKey(roomId),
					JSON.stringify(slim.slice(0, 300)),
				);
			} catch (e) {}
		},
		loadMessages(roomId) {
			try {
				return JSON.parse(
					localStorage.getItem(this.msgKey(roomId)) || '[]',
				);
			} catch (e) {
				return [];
			}
		},
		saveMessages(roomId, msgs) {
			const slim = msgs.map((m) => {
				if (!m || typeof m !== 'object') return m;
				const copy = Object.assign({}, m);
				if (copy.file && typeof copy.file === 'object') {
					const file = Object.assign({}, copy.file);
					delete file.data;
					delete file.dataB64;
					delete file.objectUrl;
					delete file.blob;
					if (file.transfer && typeof file.transfer === 'object') {
						delete file.transfer.chunkBuffer;
						delete file.transfer.queue;
						delete file.transfer.pendingChunks;
					}
					copy.file = file;
				}
				return copy;
			});
			try {
				localStorage.setItem(this.msgKey(roomId), JSON.stringify(slim));
			} catch (e) {
				// Issue 7: ストレージ容量不足を検知してユーザーに通知する
				if (
					e instanceof DOMException &&
					(e.name === 'QuotaExceededError' ||
						e.name === 'NS_ERROR_DOM_QUOTA_REACHED')
				) {
					console.warn(
						'localStorage 容量不足: メッセージを保存できませんでした',
						e,
					);
					toast(
						'ストレージ容量が不足しています。古いスペースを削除してください',
					);
				}
			}
		},
	};

	/* ===================== device user list store (global across rooms) ===================== */
	/* デバイス上のユーザーリストデータ: すべての既知ユーザーの name/image を永続保存・自動更新 */
	const UserStore = {
		key: 'nekochat_users',
		data: new Map(), // uid -> {uid, name, image}
		load() {
			try {
				const raw = localStorage.getItem(this.key);
				if (raw) {
					const arr = JSON.parse(raw);
					this.data.clear();
					for (const u of arr) {
						if (u && u.uid) {
							this.data.set(u.uid, {
								uid: u.uid,
								name: u.name || '名前なし',
								image: u.image || null,
							});
						}
					}
				}
			} catch (e) {}
		},
		save() {
			try {
				const arr = Array.from(this.data.values()).map((u) => ({
					uid: u.uid,
					name: u.name,
					image: u.image,
				}));
				localStorage.setItem(
					this.key,
					JSON.stringify(arr.slice(0, 500)),
				);
			} catch (e) {}
		},
		upsert(user) {
			if (!user || !user.uid) return;
			const prev = this.data.get(user.uid) || {};
			const next = {
				uid: user.uid,
				// Issue 5: 名前の長さを64文字に制限
				name:
					((user.name || prev.name || '名前なし') + '')
						.trim()
						.slice(0, 64) || '名前なし',
				// Issue 5: 画像は safeImageSrc で検証済みの値のみ保存
				image:
					user.image !== undefined
						? safeImageSrc(user.image)
						: prev.image,
			};
			this.data.set(user.uid, next);
			this.save();
		},
		get(uid) {
			return this.data.get(uid) || null;
		},
		upsertSelf() {
			if (!Identity || !Identity.id) return;
			this.upsert({
				uid: Identity.id,
				name: Profile.name,
				image: Profile.image,
			});
		},
	};

	/* ===================== app state ===================== */

	const HEARTBEAT_MS = 4000,
		HEARTBEAT_TIMEOUT_MS = 15000;

	const App = {
		roomId: null,
		requireExistingHost: false,
		roomOption: { name: '', persist: true, updatedAt: 0 },
		isHost: false,
		peer: null,
		hostConn: null,
		conns: new Map(),
		users: new Map(),
		roomMembers: new Set(),
		allMembers: new Map(),
		userConnections: new Map(),
		messages: new Map(),
		connected: false,
		reconnecting: false,
		heartbeatTimer: null,
		hostTimeoutTimer: null,
		clientTimers: new Map(),
		localStream: null,
		screenStream: null,
		muted: false,
		cameraOn: false,
		screenOn: false,
		captionsOn: false,
		ttsOn: false,
		voiceConns: new Map(),
		myScreenCalls: new Map(),
		screenConns: new Map(),
		mediaEls: new Map(),
		screenMediaEls: new Map(),
		videoSenders: new Map(),
		captions: new Map(),
		ephemeral: null,
		voiceMuted: new Set(),
		screenMuted: new Set(),
		fileTransfers: new Map(),
		transferStats: new Map(),
		fileIdIndex: new Map(), // fileId -> message
		speakingState: new Map(),
		mediaVolumes: new Map(),
		speakingMonitors: new Map(),
		currentFilePreviewUrl: null,
		bufferMonitorTimer: null,
		_bufferWarned: false,
		userNicknames: new Map(), // uid -> nickname (local only)
		mutedUsers: new Set(), // uids muted by self
		_objectUrls: new Set(), // Issue 10: objectURL ライフサイクル追跡
		_reconnectAttempt: 0, // 再接続試行回数（ステータス表示用）
		_wasInVoice: false, // 再接続前にボイスチャット参加中だったか
		_prevReconnecting: false, // reconnectAfterLoss を経由した再接続か（トースト制御用）
		wakeLockSentinel: null,
		_sr: null, // SpeechRecognition インスタンス
		_srRestartTimer: null, // SR 再起動用タイマー
		_captionDotTimer: null, // 字幕タイピングドットアニメーションタイマー
		_captionTyping: new Map(), // uid -> true (入力中ユーザー)
	};

	// fileId -> message の逆引きインデックスを更新するヘルパー。
	// App.messages に chat/file メッセージをセットする箇所は必ずこれも呼ぶこと。
	function indexMessage(m) {
		if (m && m.file && m.file.fileId) {
			App.fileIdIndex.set(m.file.fileId, m);
		}
	}
	function findMessageByFileId(fileId) {
		if (!fileId) return null;
		const cached = App.fileIdIndex.get(fileId);
		if (cached && App.messages.get(cached.id) === cached) return cached;
		// インデックスに無い/不整合な場合のみ線形探索でフォールバック
		const found = Array.from(App.messages.values()).find(
			(m) => m.file && m.file.fileId === fileId,
		);
		if (found) App.fileIdIndex.set(fileId, found);
		return found || null;
	}

	function myMeta() {
		return {
			uid: Identity.id,
			name: Profile.name,
			image: Profile.image,
			captionsOn: App.captionsOn,
			ttsOn: App.ttsOn,
			inVoice: !!App.localStream,
			peerId: App.peer ? App.peer.id : null,
		};
	}

	/**
	 * 接続時メタデータ（ホストへの参加証明付き）
	 * uid の所有権を ECDSA 署名で証明する。これにより他者 uid の偽装を防止。
	 */
	async function createConnectMetadata() {
		const ts = Date.now();
		const peerId = App.peer ? App.peer.id : null;
		const signable = {
			k: 'connect-auth',
			roomId: App.roomId,
			uid: Identity.id,
			peerId: peerId,
			ts: ts,
		};
		const sig = await signPayload(signable);
		return {
			uid: Identity.id,
			name: Profile.name,
			image: Profile.image,
			captionsOn: App.captionsOn,
			ttsOn: App.ttsOn,
			inVoice: !!App.localStream,
			peerId: peerId,
			pub: Identity.pubJwk,
			sig: sig,
			ts: ts,
		};
	}

	function nextConnectSession() {
		App.connectSession = (App.connectSession || 0) + 1;
		return App.connectSession;
	}

	function isConnectSessionActive(sessionId, roomId) {
		return App.connectSession === sessionId && App.roomId === roomId;
	}

	/* ===================== connection lifecycle ===================== */

	function resetConnectionState(keepUsers, skipVoiceRestore) {
		clearInterval(App.heartbeatTimer);
		App.heartbeatTimer = null;
		clearTimeout(App.hostTimeoutTimer);
		App.hostTimeoutTimer = null;
		App.clientTimers.forEach((t) => clearTimeout(t));
		App.clientTimers.clear();
		App.fileTransfers.forEach((state) => {
			if (state && state.requestTimer) clearTimeout(state.requestTimer);
		});
		if (App.bufferMonitorTimer) {
			clearInterval(App.bufferMonitorTimer);
			App.bufferMonitorTimer = null;
		}
		if (App._bufStats) App._bufStats.clear();
		// ルーム移動（skipVoiceRestore=true）の場合は _wasInVoice を更新しない。
		// 切断からの再接続と誤認して新スペースで通話を自動開始するのを防ぐ。
		if (!skipVoiceRestore) {
			App._wasInVoice = App._wasInVoice || !!App.localStream;
		} else {
			App._wasInVoice = false;
		}
		leaveVoiceChat();
		// 進行中の connectFlow / 再試行をすべて無効化する
		App.connectSession = (App.connectSession || 0) + 1;
		if (App.peer) {
			try {
				App.peer.destroy();
			} catch (e) {}
		}
		App.peer = null;
		App.hostConn = null;
		App.conns = new Map();
		App.connected = false;
		App.reconnecting = false;
		App.isHost = false;
		// keepUsers=true の場合（再接続中）はユーザーリストを保持して
		// 再接続完了前に参加者が消えるのを防ぐ
		if (!keepUsers) {
			App.users = new Map();
			App.userConnections = new Map();
			App.roomMembers = new Set();
			App.allMembers = new Map();
		}
	}
	function setStatus(ok, label) {
		const el = document.getElementById('connStatus');
		el.textContent = label;
		el.className = ok ? 'ok' : 'bad';
	}

	function connectFlow() {
		// ルームから退出済みの場合は接続を開始しない
		if (!App.roomId) return;
		setStatus(false, '接続中...');
		const targetRoomId = App.roomId;
		const requireExistingHost = App.requireExistingHost;
		const sessionId = nextConnectSession();
		const isActive = () => isConnectSessionActive(sessionId, targetRoomId);
		const startPeer = (suffix, connectAttempt) => {
			connectAttempt = connectAttempt || 0;
			const peer = new Peer(
				userPeerId(targetRoomId, Identity.id, suffix),
				STUN_CONFIG,
			);
			App.peer = peer;
			let settled = false;
			let timeout;

			// settled=true にしてタイマーをキャンセルし、
			// peer を破棄してからホスト昇格を試みる共通処理
			const tryBecomeHost = () => {
				if (settled || !isActive()) return;
				settled = true;
				clearTimeout(timeout);
				try {
					peer.destroy();
				} catch (e) {}

				// ルームが切り替わっていたら古いconnectFlowの処理を中断
				if (!isActive()) return;

				// 未登録ルームでホストが見つからなかった場合はホームへ戻す
				if (requireExistingHost) {
					toast('ルームが見つかりませんでした。');
					leaveCurrentRoom();
					return;
				}

				App.requireExistingHost = false;
				let promotionAttempt = 0;

				// ホスト昇格 → unavailable-id ならゲスト試行 → 失敗ならホスト試行、のループ
				const attemptHost = () => {
					if (!isActive()) return;
					if (promotionAttempt > 8) {
						console.warn(
							'Promotion loop exceeded limit, giving up.',
						);
						App._reconnectAttempt = 0;
						App.reconnecting = false;
						resetConnectionState(/* keepUsers */ false);
						setStatus(false, '接続中...');
						toast('接続に失敗しました。再入室してください。');
						return;
					}
					promotionAttempt++;
					setStatus(false, '接続中...');

					const hp = new Peer(hostPeerId(targetRoomId), STUN_CONFIG);
					App.peer = hp;

					hp.on('disconnected', () => {
						if (!isActive()) return;
						if (!hp.destroyed) {
							try {
								hp.reconnect();
							} catch (e) {}
						}
					});

					hp.once('open', () => {
						if (!isActive()) {
							try {
								hp.destroy();
							} catch (e) {}
							return;
						}
						// 昇格成功
						App.isHost = true;
						App.connected = true;
						const selfUid = Identity.id;
						for (const uid of Array.from(App.users.keys())) {
							if (uid !== selfUid) App.users.delete(uid);
						}
						for (const uid of Array.from(App.roomMembers)) {
							if (uid !== selfUid) App.roomMembers.delete(uid);
						}
						for (const uid of Array.from(
							App.userConnections.keys(),
						)) {
							if (uid !== selfUid)
								App.userConnections.delete(uid);
						}
						App.roomMembers.add(Identity.id);
						const meta = myMeta();
						App.users.set(Identity.id, meta);
						App.allMembers.set(Identity.id, meta);
						UserStore.upsertSelf();
						if (!App.userConnections.has(Identity.id))
							App.userConnections.set(Identity.id, new Set());
						App.userConnections.get(Identity.id).add(hp.id);
						setupHostHandlers(hp);
						setStatus(true, '接続済み');
						App.reconnecting = false;
						App._reconnectAttempt = 0;
						renderHeader();
						renderVoiceScreen();
						setOwnVoiceOption({});
						if (App._prevReconnecting) {
							App._prevReconnecting = false;
							toast('再接続しました');
						}
						if (App._wasInVoice && !App.localStream) {
							rejoinVoiceAfterReconnect();
						} else if (isVoiceMode() && !App.localStream) {
							openVoiceJoinModal();
							clearVoiceModeParam();
						}
					});

					hp.on('error', (err) => {
						try {
							hp.destroy();
						} catch (e) {}
						if (!isActive()) return;
						if (err.type !== 'unavailable-id') {
							console.warn('Host peer error:', err);
							// 予期しないエラー → 少し待ってホスト再試行
							setTimeout(() => {
								if (isActive()) attemptHost();
							}, 500);
							return;
						}
						// unavailable-id: 他のゲストが先に昇格した可能性がある
						// → ゲストとして繋がれるか短時間で確認し、
						//   繋がればゲスト参加、繋がらなければホスト再試行
						setStatus(false, '接続中...');
						attemptGuest();
					});
				};

				// ゲスト接続を短いタイムアウトで試みる
				const attemptGuest = () => {
					if (!isActive()) return;
					let guestSettled = false;
					let guestTimeout;

					const gp = new Peer(
						userPeerId(targetRoomId, Identity.id, 'p'),
						STUN_CONFIG,
					);
					App.peer = gp;

					const cleanup = () => {
						clearTimeout(guestTimeout);
						try {
							gp.destroy();
						} catch (e) {}
					};

					gp.once('open', async () => {
						if (guestSettled || !isActive()) {
							cleanup();
							return;
						}
						let connMeta;
						try {
							connMeta = await createConnectMetadata();
						} catch (e) {
							cleanup();
							setTimeout(() => {
								if (isActive()) attemptHost();
							}, 300);
							return;
						}
						if (guestSettled || !isActive()) {
							cleanup();
							return;
						}

						const gc = gp.connect(hostPeerId(targetRoomId), {
							metadata: connMeta,
							reliable: true,
							serialization: 'binary',
						});

						// 2秒以内に開通しなければホスト不在と判断してホスト再試行
						guestTimeout = setTimeout(() => {
							if (guestSettled || !isActive()) return;
							guestSettled = true;
							cleanup();
							setTimeout(() => {
								if (isActive()) attemptHost();
							}, 200);
						}, 2000);

						gc.once('open', () => {
							if (guestSettled) return;
							guestSettled = true;
							clearTimeout(guestTimeout);
							if (!isActive()) {
								try {
									gc.close();
								} catch (e) {}
								try {
									gp.destroy();
								} catch (e) {}
								return;
							}
							// ゲスト参加成功
							App.isHost = false;
							App.hostConn = gc;
							App.connected = true;
							App.roomMembers.add(Identity.id);
							const meta = myMeta();
							App.users.set(Identity.id, meta);
							App.allMembers.set(Identity.id, meta);
							UserStore.upsertSelf();
							if (!App.userConnections.has(Identity.id))
								App.userConnections.set(Identity.id, new Set());
							App.userConnections.get(Identity.id).add(gp.id);
							setupClientConnHandlers(gc);
							setupPeerCallHandler(gp);
							startClientHeartbeat(gc);
							setStatus(true, '接続済み');
							App.reconnecting = false;
							App._reconnectAttempt = 0;
							renderHeader();
							renderVoiceScreen();
							setOwnVoiceOption({});
							syncOwnHistoryToHost();
							if (App._prevReconnecting) {
								App._prevReconnecting = false;
								toast('再接続しました');
							}
							if (App._wasInVoice && !App.localStream) {
								rejoinVoiceAfterReconnect();
							} else if (isVoiceMode() && !App.localStream) {
								openVoiceJoinModal();
								clearVoiceModeParam();
							}
						});

						gc.on('error', () => {
							if (guestSettled) return;
							guestSettled = true;
							cleanup();
							setTimeout(() => {
								if (isActive()) attemptHost();
							}, 200);
						});
					});

					gp.on('error', () => {
						if (guestSettled) return;
						guestSettled = true;
						cleanup();
						setTimeout(() => {
							if (isActive()) attemptHost();
						}, 300);
					});
				};

				attemptHost();
			};

			peer.on('disconnected', () => {
				// ルームが切り替わっていたら再接続しない
				if (!isActive()) return;
				if (!peer.destroyed) {
					try {
						peer.reconnect();
					} catch (e) {}
				}
			});

			peer.once('open', async () => {
				// ルームが切り替わっていたら処理を中断
				if (!isActive()) {
					try {
						peer.destroy();
					} catch (e) {}
					return;
				}
				let connMeta;
				try {
					connMeta = await createConnectMetadata();
				} catch (e) {
					// 署名生成失敗（まれ）→ ホスト昇格へフォールバック
					console.warn('createConnectMetadata failed:', e);
					tryBecomeHost();
					return;
				}
				if (settled || !isActive()) return; // open 前に peer-unavailable が来た場合

				const conn = peer.connect(hostPeerId(targetRoomId), {
					metadata: connMeta,
					reliable: true,
					serialization: 'binary',
				});

				const wireConn = (c) => {
					c.once('open', () => {
						if (settled || !isActive()) return;
						// ルームが切り替わっていたら接続確立を中断
						if (!isActive()) {
							try {
								c.close();
							} catch (e) {}
							try {
								peer.destroy();
							} catch (e) {}
							return;
						}
						settled = true;
						clearTimeout(timeout);
						App.isHost = false;
						App.hostConn = c;
						App.connected = true;
						App.requireExistingHost = false;
						App.roomMembers.add(Identity.id);
						const meta = myMeta();
						App.users.set(Identity.id, meta);
						App.allMembers.set(Identity.id, meta);
						UserStore.upsertSelf();
						if (!App.userConnections.has(Identity.id))
							App.userConnections.set(Identity.id, new Set());
						App.userConnections.get(Identity.id).add(peer.id);
						setupClientConnHandlers(c);
						setupPeerCallHandler(peer);
						startClientHeartbeat(c);
						setStatus(true, '接続済み');
						App.reconnecting = false;
						App._reconnectAttempt = 0;
						renderHeader();
						renderVoiceScreen();
						// 暗号検証済みのプレゼンスを直ちに発信してセキュリティを確立
						setOwnVoiceOption({});
						syncOwnHistoryToHost();
						if (App._prevReconnecting) {
							App._prevReconnecting = false;
							toast('再接続しました');
						}
						// 再接続前にボイスチャット参加中だった場合は自動復帰
						if (App._wasInVoice && !App.localStream) {
							rejoinVoiceAfterReconnect();
						} else if (isVoiceMode() && !App.localStream) {
							openVoiceJoinModal();
							clearVoiceModeParam();
						}
					});
					// DataChannel レベルのエラーはホスト不在の確証にならない。
					// peer-unavailable は peer.on('error') 側で捕捉する。
					c.on('error', (err) => {
						console.warn(
							'DataChannel error (ignored for host detection):',
							err,
						);
					});
				};
				wireConn(conn);

				// 8秒以内に開通しなくても、それだけでは「ホスト不在」と断定できない
				// (WebRTC/ICE のネゴシエーションが遅延しているだけの可能性が高い)。
				// signaling 経由の peer-unavailable のみを「確証」として扱い、
				// タイムアウト時はまず接続を数回リトライしてから諦める。
				timeout = setTimeout(() => {
					if (settled || !isActive()) return;
					if (connectAttempt < 2) {
						try {
							conn.close();
						} catch (e) {}
						try {
							peer.destroy();
						} catch (e) {}
						startPeer(suffix, connectAttempt + 1);
					} else {
						tryBecomeHost();
					}
				}, 8000);
			});

			peer.on('error', (err) => {
				if (settled || !isActive()) return; // 既に決着済みは無視
				if (err.type === 'unavailable-id' && !suffix) {
					// 自分の userPeer ID が競合 → suffix 付きで再試行
					try {
						peer.destroy();
					} catch (e) {}
					startPeer(Math.random().toString(36).slice(2, 6));
				} else if (err.type === 'peer-unavailable') {
					// ホスト不在が確定 → 昇格
					tryBecomeHost();
				} else {
					// network-error 等の予期しないエラー → 昇格にフォールバック
					console.warn('Client peer error:', err);
					tryBecomeHost();
				}
			});
		};
		startPeer('');
	}

	function reconnectAfterLoss() {
		if (App.reconnecting) return;
		App._reconnectAttempt = (App._reconnectAttempt || 0) + 1;
		const attempt = App._reconnectAttempt;
		// 再接続上限（5回）を超えたら諦めて完全リセット
		if (attempt > 5) {
			console.warn('Reconnect limit reached, giving up.');
			App._reconnectAttempt = 0;
			resetConnectionState(/* keepUsers */ false);
			setStatus(false, '接続中...');
			toast('ホストへの接続に失敗しました。再入室してください。');
			return;
		}
		App.reconnecting = true;
		App._prevReconnecting = true;
		setStatus(false, '接続中...');
		// 初回切断検知時のみトーストを出す（リトライのたびに出さない）
		if (attempt === 1) toast('切断されました。再接続しています...');
		// ユーザーリストを保持して再接続中に参加者が消えるのを防ぐ
		resetConnectionState(/* keepUsers */ true);
		// 再接続時はホスト不在の場合に昇格を許可する（招待ルームでも継続可能に）
		App.requireExistingHost = false;
		// 試行回数に応じて待機時間を増やす（最大5秒）
		const delay = Math.min(300 + (attempt - 1) * 700, 5000);
		setTimeout(connectFlow, delay);
	}

	/* ---- host side ---- */

	function setupHostHandlers(peer) {
		peer.on('connection', (conn) => setupHostIncomingConn(conn));
		setupPeerCallHandler(peer);
	}

	function setupHostIncomingConn(conn) {
		const meta = conn.metadata || {};
		conn.on('open', async () => {
			// === セキュリティ強化: 接続時の uid 所有権検証 ===
			// meta.uid を信用せず、pubJwk + 署名で Identity.id の所有者を証明させる。
			// これにより他者 uid の偽装参加を防止（ボイス通話・ファイル配信先の誤誘導対策）。
			if (
				!meta.uid ||
				!meta.pub ||
				!meta.sig ||
				typeof meta.ts !== 'number'
			) {
				try {
					conn.close();
				} catch (e) {}
				return;
			}
			try {
				const claimedUid = await hashPub(meta.pub);
				if (claimedUid !== meta.uid) {
					try {
						conn.close();
					} catch (e) {}
					return;
				}
				const signable = {
					k: 'connect-auth',
					roomId: App.roomId,
					uid: meta.uid,
					peerId: meta.peerId || conn.peer,
					ts: meta.ts,
				};
				const ok = await verifyPayload(
					signable,
					meta.sig,
					meta.pub,
					meta.uid,
				);
				const age = Date.now() - meta.ts;
				// 許容: 時計ずれ ±10秒、全体で 2 分以内の最近の証明のみ有効
				if (!ok || age < -10000 || age > 120 * 1000) {
					try {
						conn.close();
					} catch (e) {}
					return;
				}
			} catch (e) {
				try {
					conn.close();
				} catch (e2) {}
				return;
			}
			// 検証通過後のみ参加者として登録
			if (!meta.uid) {
				// 二重チェック（念のため）
				try {
					conn.close();
				} catch (e) {}
				return;
			}
			App.conns.set(conn.peer, conn);

			if (!App.userConnections.has(meta.uid))
				App.userConnections.set(meta.uid, new Set());
			App.userConnections.get(meta.uid).add(conn.peer);

			App.users.set(meta.uid, {
				uid: meta.uid,
				// Issue 5: ピアから受け取る name/image を検証・制限する
				name: String(meta.name || '').slice(0, 64) || '名前なし',
				image: safeImageSrc(meta.image),
				captionsOn: !!meta.captionsOn,
				ttsOn: !!meta.ttsOn,
				inVoice: !!meta.inVoice,
				peerId: meta.peerId || conn.peer,
			});
			App.allMembers.set(meta.uid, {
				uid: meta.uid,
				name: String(meta.name || '').slice(0, 64) || '名前なし',
				image: safeImageSrc(meta.image),
				captionsOn: !!meta.captionsOn,
				ttsOn: !!meta.ttsOn,
				inVoice: !!meta.inVoice,
				peerId: meta.peerId || conn.peer,
			});
			UserStore.upsert({
				uid: meta.uid,
				name: meta.name,
				image: meta.image,
			});
			App.roomMembers.add(meta.uid);
			if (App.roomOption && App.roomOption.persist && App.roomId) {
				RoomStore.saveMembers(
					App.roomId,
					Array.from(App.allMembers.values()),
				);
			}
			resetClientHeartbeatTimer(conn.peer);
			conn.send({
				t: 'sys',
				sub: 'sync',
				payload: {
					users: Array.from(App.users.values()),
					allMembers: Array.from(App.allMembers.values()),
					roomOption: App.roomOption,
					// 自分が送信したメッセージのみ送信（他者のメッセージは検証が通らないため）
					messages: Array.from(App.messages.values()).filter(
						(m) => m.uid === Identity.id,
					),
					myInfo: {
						uid: Identity.id,
						name: Profile.name,
						image: Profile.image,
					},
				},
			});
			broadcast(
				{
					t: 'sys',
					sub: 'user-update',
					payload: { user: App.users.get(meta.uid) },
				},
				[conn.peer],
			);
			renderHeader();
			renderUserPopover();
			renderVoiceScreen();
			if (App.localStream && !!meta.inVoice) {
				callUser(meta.uid);
				if (App.screenOn) callScreenUser(meta.uid);
			}
		});
		conn.on('data', (data) => handleIncoming(meta.uid, data, conn.peer));
		conn.on('close', () => handleClientDisconnect(conn.peer, meta.uid));
		conn.on('error', () => handleClientDisconnect(conn.peer, meta.uid));
	}

	function handleClientDisconnect(peerId, theUid) {
		if (!peerId || !App.conns.has(peerId)) return;
		App.conns.delete(peerId);
		if (App.clientTimers.has(peerId)) {
			clearTimeout(App.clientTimers.get(peerId));
			App.clientTimers.delete(peerId);
		}

		if (App.userConnections.has(theUid)) {
			const connSet = App.userConnections.get(theUid);
			connSet.delete(peerId);
			if (connSet.size === 0) {
				App.userConnections.delete(theUid);
				App.users.delete(theUid);
				App.roomMembers.delete(theUid);
				stopVoiceWith(theUid);
				stopScreenWith(theUid);
				broadcast({
					t: 'sys',
					sub: 'user-left',
					payload: { uid: theUid },
				});
			}
		}
		renderHeader();
		renderUserPopover();
		renderVoiceScreen();
	}

	function resetClientHeartbeatTimer(peerId) {
		if (App.clientTimers.has(peerId))
			clearTimeout(App.clientTimers.get(peerId));
		App.clientTimers.set(
			peerId,
			setTimeout(() => {
				const conn = App.conns.get(peerId);
				if (conn && conn.metadata)
					handleClientDisconnect(peerId, conn.metadata.uid);
			}, HEARTBEAT_TIMEOUT_MS),
		);
	}
	function broadcast(msg, excludePeerIds) {
		excludePeerIds = excludePeerIds || [];
		App.conns.forEach((conn, peerId) => {
			if (!excludePeerIds.includes(peerId) && conn.open) conn.send(msg);
		});
	}

	/* ---- client side ---- */

	function setupClientConnHandlers(conn) {
		conn.on('data', (data) => handleIncoming('__host__', data, conn.peer));
		conn.on('close', () => {
			if (!App.reconnecting) reconnectAfterLoss();
		});
		conn.on('error', () => {
			if (!App.reconnecting) reconnectAfterLoss();
		});
	}
	function startClientHeartbeat(conn) {
		resetHostTimeout();
		App.heartbeatTimer = setInterval(() => {
			if (conn.open) conn.send({ t: 'sys', sub: 'heartbeat' });
		}, HEARTBEAT_MS);
	}
	function resetHostTimeout() {
		clearTimeout(App.hostTimeoutTimer);
		App.hostTimeoutTimer = setTimeout(() => {
			if (!App.reconnecting) reconnectAfterLoss();
		}, HEARTBEAT_TIMEOUT_MS);
	}

	/* ---- shared incoming handler ---- */

	async function handleIncoming(senderUid, data, senderPeerId) {
		if (!data || !data.t) return;
		// ミュートしている相手からの全ての通信を破棄
		if (senderUid && App.mutedUsers.has(senderUid)) return;

		if (data.t === 'sys') {
			switch (data.sub) {
				case 'sync':
					(data.payload.users || []).forEach((u) => {
						// Issue 9: sync で受け取るユーザー情報を検証・制限する
						const su = Object.assign({}, u, {
							name:
								String(u.name || '').slice(0, 64) || '名前なし',
							image: safeImageSrc(u.image),
						});
						App.users.set(su.uid, su);
						if (!App.userConnections.has(su.uid))
							App.userConnections.set(su.uid, new Set());
						if (su.peerId)
							App.userConnections.get(su.uid).add(su.peerId);
						UserStore.upsert(su);
					});
					(data.payload.allMembers || []).forEach((u) => {
						const su = Object.assign({}, u, {
							name:
								String(u.name || '').slice(0, 64) || '名前なし',
							image: safeImageSrc(u.image),
						});
						App.allMembers.set(su.uid, su);
						UserStore.upsert(su);
					});
					if (
						App.roomOption &&
						App.roomOption.persist &&
						App.roomId
					) {
						RoomStore.saveMembers(
							App.roomId,
							Array.from(App.allMembers.values()),
						);
					}
					if (
						data.payload.roomOption &&
						data.payload.roomOption.updatedAt >=
							(App.roomOption.updatedAt || 0)
					)
						applyRoomOption(data.payload.roomOption);
					const hostUid = (data.payload.myInfo && data.payload.myInfo.uid) || senderUid;
					await applyAppMessage(hostUid, {
						k: 'history',
						messages: data.payload.messages,
					});
					renderHeader();
					renderUserPopover();
					renderVoiceScreen();
					// 既にボイスチャットに参加済みの場合、
					// syncで受け取った既存参加者へストリームを送る
					if (App.localStream) {
						(data.payload.users || []).forEach((u) => {
							if (u.uid !== Identity.id && u.inVoice) {
								callUser(u.uid);
								if (App.screenOn) callScreenUser(u.uid);
							}
						});
					}
					break;
				case 'user-joined':
					if (!App.users.has(data.payload.user.uid)) {
						// Issue 9: 入室ユーザー情報を検証・制限する
						const ju = Object.assign({}, data.payload.user, {
							name:
								String(data.payload.user.name || '').slice(
									0,
									64,
								) || '名前なし',
							image: safeImageSrc(data.payload.user.image),
						});
						App.users.set(ju.uid, ju);
						App.allMembers.set(ju.uid, ju);
						UserStore.upsert(ju);
						if (
							App.roomOption &&
							App.roomOption.persist &&
							App.roomId
						) {
							RoomStore.saveMembers(
								App.roomId,
								Array.from(App.allMembers.values()),
							);
						}
						if (!App.userConnections.has(ju.uid))
							App.userConnections.set(ju.uid, new Set());
						if (ju.peerId)
							App.userConnections.get(ju.uid).add(ju.peerId);
						addSystemMessage(ju.name + ' が入室しました');
						renderHeader();
						renderUserPopover();
						renderVoiceScreen();
						renderLog();
						if (App.localStream && ju.uid !== Identity.id) {
							callUser(ju.uid);
							if (App.screenOn) callScreenUser(ju.uid);
						}
					}
					break;
				case 'user-update': {
					// Issue 9: ユーザー更新情報を検証・制限する
					const uu = Object.assign({}, data.payload.user, {
						name:
							String(data.payload.user.name || '').slice(0, 64) ||
							'名前なし',
						image: safeImageSrc(data.payload.user.image),
					});
					App.users.set(uu.uid, uu);
					App.allMembers.set(uu.uid, uu);
					UserStore.upsert(uu);
					if (
						App.roomOption &&
						App.roomOption.persist &&
						App.roomId
					) {
						RoomStore.saveMembers(
							App.roomId,
							Array.from(App.allMembers.values()),
						);
					}
					if (!App.userConnections.has(uu.uid))
						App.userConnections.set(uu.uid, new Set());
					if (uu.peerId)
						App.userConnections.get(uu.uid).add(uu.peerId);
					renderHeader();
					renderUserPopover();
					renderVoiceScreen();
					renderLog();
					// user-update で inVoice が true になった相手に、
					// 自分がボイスチャット中なら接続を開始する（後参加者との接続漏れ防止）
					if (
						App.localStream &&
						uu.uid !== Identity.id &&
						uu.inVoice &&
						!App.voiceConns.has(uu.uid)
					) {
						callUser(uu.uid);
						if (App.screenOn) callScreenUser(uu.uid);
					}
					break;
				}
				case 'user-left': {
					App.users.delete(data.payload.uid);
					App.userConnections.delete(data.payload.uid);
					renderHeader();
					renderUserPopover();
					renderVoiceScreen();
					stopVoiceWith(data.payload.uid);
					stopScreenWith(data.payload.uid);
					break;
				}
				case 'heartbeat':
					if (App.isHost && senderPeerId) {
						const conn = App.conns.get(senderPeerId);
						if (conn) {
							resetClientHeartbeatTimer(senderPeerId);
							if (conn.open) {
								conn.send({
									t: 'sys',
									sub: 'heartbeat-ack',
								});
							}
						}
					}
					break;
				case 'heartbeat-ack':
					if (!App.isHost) resetHostTimeout();
					break;
				case 'kicked':
					leaveCurrentRoom();
					break;
				case 'voice-take': {
					// ユーザー固有の強制操作(ボイスチャット切断)のため、
					// 署名を厳密に検証してから実行する(なりすまし防止)
					const vt = data.payload;
					if (!vt || !vt.uid || !vt.pub || !vt.sig || !vt.peerId)
						break;
					const vtOk = await verifyPayload(
						{
							k: 'voice-take',
							uid: vt.uid,
							roomId: App.roomId,
							ts: vt.ts,
							peerId: vt.peerId,
						},
						vt.sig,
						vt.pub,
						vt.uid,
					);
					if (!vtOk) {
						console.warn(
							'voice-take の署名検証に失敗したため無視しました',
						);
						break;
					}
					// 同一ユーザーの別ウィンドウ/別デバイスがボイスチャットに
					// 参加した場合、自分のボイスチャットを切断する
					// (ボイスチャットは複窓不可・常に最新デバイス優先)
					if (
						vt.uid === Identity.id &&
						App.peer &&
						vt.peerId !== App.peer.id &&
						App.localStream
					) {
						leaveVoiceChat();
						toast(
							'別のウィンドウ/デバイスでボイスチャットに参加したため、こちらは退出しました',
						);
					}
					// ホストは他の接続にも転送して、全ウィンドウへ通知する
					if (App.isHost) broadcast(data);
					break;
				}
				case 'voice-speaking': {
					const vs = data.payload;
					// なりすまし防止: ホストに届いたメッセージは接続レイヤーで認証済みの
					// senderUid と payload.uid が一致する場合のみ受け入れ・転送する。
					// クライアントがホストから受け取る場合は senderUid が '__host__' なので
					// ホスト経由のブロードキャストを通す。
					if (vs && vs.uid && (senderUid === '__host__' || senderUid === vs.uid)) {
						setSpeakingFlag(vs.uid, vs.kind, vs.active);
						if (App.isHost) broadcast(data);
					}
					break;
				}
				case 'voice-caption': {
					const vc = data.payload;
					// なりすまし防止: senderUid と payload.uid が一致する場合のみ受け入れ・転送する。
					// ホスト経由のブロードキャスト（senderUid === '__host__'）は通す。
					// uid 不一致のメッセージはホストも他クライアントへ転送しない。
					if (
						vc && vc.uid &&
						vc.uid !== Identity.id &&
						typeof vc.text === 'string' &&
						(senderUid === '__host__' || senderUid === vc.uid)
					) {
						// DoS 防止: テキストを 500 文字に切り詰める
						const safeText = vc.text.slice(0, 500);
						App.captions.set(vc.uid, { text: safeText, ts: vc.ts || Date.now() });
						// isFinal が明示されている場合は音声認識中のタイピングドットを管理する。
						// interim（認識途中）なら点滅ドットを表示、final（確定）なら消す。
						// isFinal が未定義の古いクライアントとも互換性を保つため、
						// 明示的に false の場合のみ interim として扱う。
						if (vc.isFinal === false) {
							App._captionTyping.set(vc.uid, true);
						} else {
							App._captionTyping.delete(vc.uid);
						}
						if (App.captionsOn) renderVoiceScreen();
						if (App.isHost) broadcast(data);
					}
					break;
				}
			}
			return;
		}
		if (data.t === 'relay' && App.isHost) {
			const targetUid = data.toUid || data.to || 'all';
			// chat/fileメッセージのrelayは、送信者が自分自身のuidを持つメッセージのみ中継する
			// (なりすましによる他ユーザーのメッセージ偽装を防ぐ)
			if (
				data.payload &&
				(data.payload.k === 'chat' || data.payload.k === 'file') &&
				data.payload.uid !== senderUid
			) {
				console.warn(
					'メッセージ送信者と接続ユーザーが一致しないrelayを拒否しました',
					{ msgUid: data.payload.uid, senderUid },
				);
				return;
			}
			// V-03: ファイル転送系ペイロードも fromUid / uid が senderUid と一致するか確認する。
			// 旧実装は k==='chat'||'file' のみガードしており、file-chunk/file-offer/file-select
			// 等は検査をすり抜けて fromUid 偽装が可能だった。
			// 署名検証は各ハンドラで行われるが、fromUid を詐称した場合に
			// ホストが誤った senderUid でブロードキャストしてしまう問題をここで防ぐ。
			const FILE_RELAY_TYPES = new Set([
				'file-chunk', 'file-offer', 'file-select',
				'file-request', 'file-control', 'file-complete',
			]);
			if (data.payload && FILE_RELAY_TYPES.has(data.payload.k)) {
				const payloadSender = data.payload.fromUid || data.payload.uid || null;
				if (payloadSender && payloadSender !== senderUid) {
					console.warn(
						'[V-03] ファイル系relayのfromUid/uidが接続ユーザーと不一致のため拒否しました',
						{ payloadSender, senderUid, k: data.payload.k },
					);
					return;
				}
			}
			if (targetUid === 'all') {
				await applyAppMessage(senderUid, data.payload);
				let senderRelayPeerId = null;
				App.conns.forEach((conn, peerId) => {
					if (conn.metadata && conn.metadata.uid === senderUid)
						senderRelayPeerId = peerId;
				});
				broadcast(
					{
						t: 'data',
						from: senderUid,
						payload: data.payload,
					},
					senderRelayPeerId ? [senderRelayPeerId] : [],
				);
			} else {
				if (targetUid === Identity.id) {
					await applyAppMessage(senderUid, data.payload);
					return;
				}
				const peerIds = Array.from(
					App.userConnections.get(targetUid) || [],
				);
				const peerId = peerIds.find(
					(pid) => App.conns.has(pid) && App.conns.get(pid).open,
				);
				if (peerId) {
					App.conns.get(peerId).send({
						t: 'data',
						from: senderUid,
						payload: data.payload,
					});
				}
			}
			return;
		}
		if (data.t === 'data') {
			await applyAppMessage(data.from, data.payload);
			return;
		}
	}

	/* ===================== RoomOption ===================== */

	function applyRoomOption(opt) {
		App.roomOption = opt;
		renderHeader();
		if (opt.persist) {
			RoomStore.upsert({
				id: App.roomId,
				name: opt.name,
				persist: true,
				lastVisited: Date.now(),
			});
			RoomStore.saveMessages(
				App.roomId,
				Array.from(App.messages.values()),
			);
		} else {
			// 永続→一時への切り替え時は RoomStore から完全に削除する
			if (App.roomId) RoomStore.remove(App.roomId);
			// 一時ルームの情報も `App.ephemeral` に保持・更新して一覧描画時に連動させる
			App.ephemeral = {
				id: App.roomId,
				name: opt.name,
				persist: false,
				lastVisited: Date.now(),
			};
		}
		renderRoomList();
	}
	async function updateRoomOption(partial) {
		const ts = Date.now();
		const opt = Object.assign({}, App.roomOption, partial, {
			updatedAt: ts,
		});
		applyRoomOption(opt);

		// ルーム変更変更者の電子署名を検証するためにシグネチャを送信
		const signable = {
			k: 'room-option',
			uid: Identity.id,
			roomId: App.roomId,
			ts: ts,
			value: {
				name: opt.name,
				persist: !!opt.persist,
				updatedAt: opt.updatedAt,
			},
		};
		const sig = await signPayload(signable);
		distribute({
			k: 'room-option',
			uid: Identity.id,
			value: opt,
			ts: ts,
			pub: Identity.pubJwk,
			sig,
		});
	}

	/* ===================== app messages ===================== */

	async function applyAppMessage(fromUid, payload) {
		if (!payload || !payload.k) return;

		if (payload.k === 'file-request') {
			return await handleFileRequest(payload);
		}
		if (payload.k === 'file-offer') {
			return await handleFileOffer(payload);
		}
		if (payload.k === 'file-select') {
			return await handleFileSelect(payload);
		}
		if (payload.k === 'file-chunk') {
			return await handleIncomingFileChunk(payload);
		}
		if (payload.k === 'file-complete') {
			return await handleFileComplete(payload);
		}
		if (payload.k === 'file-control') {
			return await handleFileControl(payload);
		}
		if (payload.k === 'room-option') {
			if (!payload.pub || !payload.sig || !payload.uid) {
				console.warn(
					'検証用データが不足しているため、ルーム設定変更を無視しました',
				);
				return;
			}
			const ok = await verifyPayload(
				{
					k: 'room-option',
					uid: payload.uid,
					roomId: App.roomId,
					ts: payload.ts,
					value: {
						name: payload.value.name,
						persist: !!payload.value.persist,
						updatedAt: payload.value.updatedAt,
					},
				},
				payload.sig,
				payload.pub,
				payload.uid,
			);
			if (!ok) {
				console.warn('ルーム設定変更の署名検証に失敗しました');
				return;
			}
			if (
				payload.value &&
				payload.value.updatedAt >= (App.roomOption.updatedAt || 0)
			)
				applyRoomOption(payload.value);
			return;
		}
		if (payload.k === 'presence') {
			if (!payload.pub || !payload.sig || !payload.uid) {
				console.warn(
					'検証用データが不足しているため、Presence更新を無視しました',
				);
				return;
			}
			const ok = await verifyPayload(
				{
					k: 'presence',
					uid: payload.uid,
					roomId: App.roomId,
					ts: payload.ts,
					user: {
						name: payload.user.name,
						image: payload.user.image,
						captionsOn: !!payload.user.captionsOn,
						ttsOn: !!payload.user.ttsOn,
						inVoice: !!payload.user.inVoice,
						cameraOn: !!payload.user.cameraOn,
					},
				},
				payload.sig,
				payload.pub,
				payload.uid,
			);
			if (!ok) {
				console.warn('Presence更新の署名検証に失敗しました');
				return;
			}
			// Issue 9: 受信した presence の name/image を検証・制限してから保存する
			const sanitizedPresenceUser = Object.assign({}, payload.user, {
				uid: payload.uid,
				name:
					String(payload.user.name || '').slice(0, 64) || '名前なし',
				image: safeImageSrc(payload.user.image),
				cameraOn: !!payload.user.cameraOn,
			});
			App.users.set(payload.uid, sanitizedPresenceUser);
			App.allMembers.set(payload.uid, sanitizedPresenceUser);
			UserStore.upsert(sanitizedPresenceUser);
			if (App.roomOption && App.roomOption.persist && App.roomId) {
				RoomStore.saveMembers(
					App.roomId,
					Array.from(App.allMembers.values()),
				);
			}
			renderHeader();
			renderUserPopover();
			renderVoiceScreen();
			renderLog();
			refreshSocialIfOpen();
			// presence で inVoice が true になった相手に、
			// 自分がボイスチャット中なら接続を開始する（後参加者との接続漏れ防止）
			if (
				App.localStream &&
				payload.uid !== Identity.id &&
				sanitizedPresenceUser.inVoice &&
				!App.voiceConns.has(payload.uid)
			) {
				callUser(payload.uid);
				if (App.screenOn) callScreenUser(payload.uid);
			}
			return;
		}
		if (payload.k === 'history') {
			for (const m of payload.messages || []) {
				if (m.uid && App.mutedUsers.has(m.uid)) continue;
				// 送信者以外のユーザーのメッセージが含まれている場合は無視する (なりすまし防止)
				if (fromUid !== '__host__' && m.uid !== fromUid) {
					console.warn(
						'送信者と一致しない履歴メッセージを無視しました:',
						m.id,
					);
					continue;
				}
				// 履歴同期されたメッセージのシグネチャ検証を厳密に実行
				if (m.k === 'chat' || m.k === 'file') {
					// 署名データが存在しないメッセージは受け入れない
					if (!m.pub || !m.sig || !m.uid) {
						console.warn(
							'署名データが存在しない履歴メッセージを拒否しました:',
							m.id,
						);
						continue;
					}
					const ok = await verifyPayload(
						{
							k: m.k,
							id: m.id,
							uid: m.uid,
							roomId: App.roomId,
							text: m.text || null,
							fileMeta: m.file
								? {
										name: m.file.name,
										size: m.file.size,
										mime: m.file.mime,
										fileId: m.file.fileId || null,
										hash: m.file.hash || null,
										chunkSize: m.file.chunkSize || null,
									}
								: null,
							replyTo: m.replyTo
								? {
										id: m.replyTo.id,
										uid: m.replyTo.uid,
										name: m.replyTo.name || null,
										text: m.replyTo.text || null,
									}
								: null,
							ts: m.ts,
						},
						m.sig,
						m.pub,
						m.uid,
						true, // skipTimestampCheck: 履歴メッセージの署名検証時は時間検証をスキップする
					);
					if (!ok) {
						console.warn(
							'履歴メッセージの署名検証に失敗したためスキップしました:',
							m.id,
						);
						continue;
					}
				}
				// data/dataB64 完全廃止 + 常に meta 正規化
				if (m.file && m.file.fileId) {
					m.file = normalizeFileMeta(m.file);
					hydrateFilePreview(m.file, false);
				}
				if (
					!App.messages.has(m.id) ||
					(m.deleted && !App.messages.get(m.id).deleted)
				) {
					const wasDeleted = App.messages.has(m.id) && App.messages.get(m.id).deleted;
					App.messages.set(m.id, m);
					indexMessage(m);
					if (m.deleted && !wasDeleted) {
						// ファイルメッセージ削除時は関連ファイルをIndexedDBから削除
						if (m.k === 'file' && m.file && m.file.fileId) {
							deleteFileRecord(m.file.fileId).catch(() => {});
							App.fileTransfers.delete(m.file.fileId);
						}
					}
				}
			}
			persistIfNeeded();
			renderLog();
			return;
		}
		if (payload.k === 'chat' || payload.k === 'file') {
			if (App.messages.has(payload.id)) return;
			if (payload.uid && App.mutedUsers.has(payload.uid)) return;
			const ok = await verifyPayload(
				{
					k: payload.k,
					id: payload.id,
					uid: payload.uid,
					roomId: App.roomId,
					text: payload.text || null,
					fileMeta: payload.file
						? {
								name: payload.file.name,
								size: payload.file.size,
								mime: payload.file.mime,
								fileId: payload.file.fileId || null,
								hash: payload.file.hash || null,
								chunkSize: payload.file.chunkSize || null,
							}
						: null,
					replyTo: payload.replyTo
						? {
								id: payload.replyTo.id,
								uid: payload.replyTo.uid,
								name: payload.replyTo.name || null,
								text: payload.replyTo.text || null,
							}
						: null,
					ts: payload.ts,
				},
				payload.sig,
				payload.pub,
				payload.uid,
			);
			if (!ok) {
				console.warn('署名検証に失敗したメッセージを破棄しました');
				return;
			}
			// data / dataB64 は完全廃止したため埋め込み処理は削除
			App.messages.set(payload.id, payload);
			indexMessage(payload);
			persistIfNeeded();
			appendMessageEl(payload);
			scrollLogToBottom();

			if (
				payload.k === 'file' &&
				payload.file &&
				payload.file.senderUid !== Identity.id
			) {
				const file = payload.file;
				const state = currentFileState(file.fileId);
				// プッシュ転送が既に開始/完了している場合は上書きしない
				if (
					state.status !== 'receiving' &&
					state.status !== 'complete'
				) {
					state.status = 'offered';
				}
				state.file = cloneFileMeta(file);
				state.currentSenderUid = file.senderUid || payload.uid;
				App.fileTransfers.set(file.fileId, state);
				const hasLocal = await hasLocalFileRecord(file.fileId);
				if (hasLocal) {
					state.status = 'complete';
				} else if (
					state.status !== 'receiving' &&
					state.status !== 'complete'
				) {
					// プッシュ転送がまだ届いていない場合のみ、フォールバックとして
					// 一定時間後に自動でプル要求を送る
					scheduleAutoAccept(file);
				}
			}

			if (App.localStream) {
				// B1 fix: payload.file が null の場合でも安全にテキストを生成する
				const capText =
					payload.k === 'file'
						? 'ファイル: ' + (payload.file && payload.file.name ? payload.file.name : '（不明）')
						: (payload.text || '');
				App.captions.set(payload.uid, {
					text: capText,
					ts: payload.ts,
				});
				if (App.captionsOn) {
					renderVoiceScreen();
				}
				// B3 fix: SpeechSynthesis 非サポート環境でのエラーを防ぐ
				if (App.ttsOn && payload.k === 'chat' && payload.text) {
					if (typeof speechSynthesis !== 'undefined' && speechSynthesis.speak) {
						try {
							const u = new SpeechSynthesisUtterance(payload.text);
							u.lang = 'ja-JP';
							speechSynthesis.speak(u);
						} catch (e) {}
					}
				}
			}
			return;
		}
		if (payload.k === 'delete') {
			const m = App.messages.get(payload.id);
			if (m && !m.deleted) {
				// 削除送信者がそのメッセージの作成者本人であるか検証
				if (payload.uid !== m.uid) {
					console.warn(
						'メッセージの作成者以外の削除要求を無視しました',
					);
					return;
				}
				// 削除要求ペイロード自体に対する署名チェック
				const ok = await verifyPayload(
					{
						k: 'delete',
						id: payload.id,
						uid: payload.uid,
						roomId: App.roomId,
						ts: payload.ts,
					},
					payload.sig,
					payload.pub,
					payload.uid,
				);
				if (!ok) {
					console.warn('削除要求の署名検証に失敗しました');
					return;
				}
				m.deleted = true;
				persistIfNeeded();
				const el = document.getElementById('m_' + payload.id);
				if (el) markElDeleted(el);
				// ファイルメッセージ削除時は関連ファイルをIndexedDBから削除（他クライアントも）
				if (m.k === 'file' && m.file && m.file.fileId) {
					deleteFileRecord(m.file.fileId).catch(() => {});
					App.fileTransfers.delete(m.file.fileId);
				}
			}
			return;
		}
		if (payload.k === 'typing') {
			if (!payload.pub || !payload.sig || !payload.uid) return;
			const ok = await verifyPayload(
				{
					k: 'typing',
					uid: payload.uid,
					roomId: App.roomId,
					ts: payload.ts,
					active: !!payload.active,
				},
				payload.sig,
				payload.pub,
				payload.uid,
			);
			if (!ok) return;
			if (payload.uid === Identity.id) return;
			TypingState.receive(payload.uid, !!payload.active);
			// 字幕でのタイピングドット表示用にも記録
			if (payload.active) {
				App._captionTyping.set(payload.uid, true);
			} else {
				App._captionTyping.delete(payload.uid);
			}
			return;
		}
	}

	async function sendAppMessage(base) {
		const signable = {
			k: base.k,
			id: base.id,
			uid: Identity.id,
			roomId: App.roomId,
			text: base.text || null,
			fileMeta: base.file
				? {
						name: base.file.name,
						size: base.file.size,
						mime: base.file.mime,
						fileId: base.file.fileId || null,
						hash: base.file.hash || null,
						chunkSize: base.file.chunkSize || null,
					}
				: null,
			replyTo: base.replyTo
				? {
						id: base.replyTo.id,
						uid: base.replyTo.uid,
						name: base.replyTo.name || null,
						text: base.replyTo.text || null,
					}
				: null,
			ts: base.ts,
		};
		const sig = await signPayload(signable);
		const payload = Object.assign({}, base, {
			uid: Identity.id,
			roomId: App.roomId,
			name: myMeta().name,
			pub: Identity.pubJwk,
			sig,
		});
		App.messages.set(payload.id, payload);
		indexMessage(payload);
		persistIfNeeded();
		appendMessageEl(payload);
		scrollLogToBottom();
		distribute(payload);
		if (App.localStream) {
			// B7 fix: payload.file が null の場合でも安全にテキストを生成する
			const selfCapText =
				payload.k === 'file'
					? 'ファイル: ' + (payload.file && payload.file.name ? payload.file.name : '（不明）')
					: (payload.text || '');
			App.captions.set(Identity.id, {
				text: selfCapText,
				ts: payload.ts,
			});
			if (App.captionsOn) {
				renderVoiceScreen();
			}
		}
		return payload;
	}
	function distribute(payload) {
		if (App.isHost) {
			broadcast({ t: 'data', from: Identity.id, payload });
		} else if (App.hostConn && App.hostConn.open) {
			App.hostConn.send({ t: 'relay', to: 'all', payload });
		}
	}
	function distributeSys(msg) {
		if (App.isHost) broadcast(msg);
		else if (App.hostConn && App.hostConn.open) App.hostConn.send(msg);
	}
	function collectOwnHistoryMessages() {
		const seen = new Set();
		return Array.from(App.messages.values()).filter((m) => {
			if (!m || seen.has(m.id)) return false;
			seen.add(m.id);
			return (
				(m.k === 'chat' || m.k === 'file') &&
				m.uid === Identity.id &&
				m.roomId === App.roomId &&
				!!m.pub &&
				!!m.sig
			);
		});
	}

	function syncOwnHistoryToHost() {
		if (App.isHost || !App.connected || !App.hostConn || !App.hostConn.open)
			return;
		const messages = collectOwnHistoryMessages();
		if (!messages.length) return;
		distribute({
			k: 'history',
			messages,
		});
	}

	async function sendDeleteFor(id) {
		const m = App.messages.get(id);
		if (!m) return;
		// 送信者本人以外は要求を送信しない
		if (m.uid !== Identity.id) return;

		m.deleted = true;
		persistIfNeeded();
		const el = document.getElementById('m_' + id);
		if (el) markElDeleted(el);
		// ファイルメッセージ削除時は関連ファイルをIndexedDBから削除
		if (m.k === 'file' && m.file && m.file.fileId) {
			deleteFileRecord(m.file.fileId).catch(() => {});
			App.fileTransfers.delete(m.file.fileId);
		}

		// 安全性の強化：メッセージの物理削除時に署名を生成して他クライアントへ配布
		const ts = Date.now();
		const signable = {
			k: 'delete',
			id: id,
			uid: Identity.id,
			roomId: App.roomId,
			ts: ts,
		};
		const sig = await signPayload(signable);
		distribute({
			k: 'delete',
			id,
			uid: Identity.id,
			roomId: App.roomId,
			ts,
			pub: Identity.pubJwk,
			sig,
		});
	}
	async function setOwnVoiceOption(partial) {
		// 操作検証：自分自身のオプション更新であることを確認
		if (!Identity.id) {
			console.warn('Identity not initialized');
			return;
		}

		const me = Object.assign(
			{},
			App.users.get(Identity.id) || myMeta(),
			partial,
		);
		// uid が Identity.id 以外に設定されていないか検証
		if (me.uid && me.uid !== Identity.id) {
			console.warn("Attempting to modify another user's options");
			return;
		}
		me.uid = Identity.id;
		App.users.set(Identity.id, me);
		App.allMembers.set(Identity.id, me);
		UserStore.upsertSelf();
		renderUserPopover();
		renderVoiceScreen();
		refreshSocialIfOpen();
		if (App.connected) {
			// 安全性の強化：プレゼンス変更情報自体に署名を乗せてブロードキャスト
			const ts = Date.now();
			const signable = {
				k: 'presence',
				uid: Identity.id,
				roomId: App.roomId,
				ts: ts,
				user: {
					name: me.name,
					image: me.image,
					captionsOn: !!me.captionsOn,
					ttsOn: !!me.ttsOn,
					inVoice: !!me.inVoice,
					cameraOn: !!me.cameraOn,
				},
			};
			const sig = await signPayload(signable);
			distribute({
				k: 'presence',
				uid: Identity.id,
				user: me,
				ts: ts,
				pub: Identity.pubJwk,
				sig,
			});
		}
	}
	function persistIfNeeded() {
		if (App.roomOption.persist && App.roomId)
			RoomStore.saveMessages(
				App.roomId,
				Array.from(App.messages.values()),
			);
	}
	function addSystemMessage(text) {
		if (!text) return;
		appendSystemEl({ text });
		scrollLogToBottom();
	}

	/* ===================== voice chat ===================== */

	function setupPeerCallHandler(peer) {
		peer.on('call', (call) => {
			const remoteUid = call.metadata && call.metadata.uid;
			const isScreen = call.metadata && call.metadata.screen;

			// user-joined より先に call が届くレースコンディションを考慮して
			// 最大 1.5 秒・3 回まで再試行してから拒否する
			function tryAnswer() {
				if (!remoteUid || !App.connected) {
					try { call.close(); } catch (e) {}
					return;
				}
				if (!App.users.has(remoteUid)) {
					const retries = (call._answerRetries = (call._answerRetries || 0) + 1);
					if (retries <= 3) {
						setTimeout(tryAnswer, 500);
						return;
					}
					// 安全性の強化：室内の正式な参加者リスト（App.users）にいないPeerからの着信を拒否
					try { call.close(); } catch (e) {}
					return;
				}
				if (isScreen) {
					// 画面共有の着信：ボイスチャット参加中のみ受け入れる
					if (!App.localStream) {
						try { call.close(); } catch (e) {}
						return;
					}
					call.answer();
					bindScreenCall(call);
				} else {
					// ボイスの着信：localStream があれば送信付きで応答
					if (!App.localStream) {
						try { call.close(); } catch (e) {}
						return;
					}
					call.answer(App.localStream);
					bindCall(call);
				}
			}
			tryAnswer();
		});
	}
	function resolveCallTargetId(theUid) {
		if (theUid === hostUidIfKnown()) return hostPeerId(App.roomId);
		// ピアID衝突でsuffix付きIDに接続している相手にも届くよう、
		// 既知のpeerId（実際に接続済みのID）があればそちらを優先する
		const known = App.users.get(theUid);
		if (known && known.peerId) return known.peerId;
		return userPeerId(App.roomId, theUid);
	}
	function callUser(theUid) {
		if (theUid === Identity.id) return;
		// 接続の重複（双方向の多重発信）を防ぐため、UIDを比較して自分が発信側になるべきか判定
		if (Identity.id >= theUid) return;
		if (!App.peer || App.peer.destroyed) return;
		if (!App.localStream) return;
		// 既に安定した接続がある場合は再接続しない
		const existingConn = App.voiceConns.get(theUid);
		if (existingConn) {
			const pc = existingConn.peerConnection;
			if (
				pc &&
				(pc.iceConnectionState === 'connected' ||
					pc.iceConnectionState === 'completed')
			)
				return;
		}
		const targetId = resolveCallTargetId(theUid);
		const call = App.peer.call(targetId, App.localStream, {
			metadata: { uid: Identity.id },
		});
		// 発信側: metadata.uid は自分のUID（着信側が発信者を識別するため）だが、
		// bindCall は remote を相手のUIDとして使うため theUid を明示的に渡す
		if (call) bindCall(call, theUid);
	}
	function callScreenUser(theUid) {
		if (theUid === Identity.id) return;
		if (!App.screenStream) return;
		if (!App.peer || App.peer.destroyed) return;
		// 既に安定した接続がある場合は再接続しない
		const existingConn = App.myScreenCalls.get(theUid);
		if (existingConn) {
			const pc = existingConn.peerConnection;
			if (
				pc &&
				(pc.iceConnectionState === 'connected' ||
					pc.iceConnectionState === 'completed')
			)
				return;
		}
		const targetId = resolveCallTargetId(theUid);
		if (!targetId) return;
		const call = App.peer.call(targetId, App.screenStream, {
			metadata: { uid: Identity.id, screen: true },
		});
		if (call) {
			App.myScreenCalls.set(theUid, call);
			call.on('close', () => App.myScreenCalls.delete(theUid));
			call.on('error', () => App.myScreenCalls.delete(theUid));
		}
	}
	function hostUidIfKnown() {
		return App.isHost ? Identity.id : null;
	}
	function bindCall(call, overrideRemoteUid) {
		// 発信側は metadata.uid が自分自身のため、相手のUIDを上書き引数で受け取る
		const remote = overrideRemoteUid || (call.metadata && call.metadata.uid);
		// 安全性の強化：接続中のアクティブな室内にいないPeerからのメディアストリームの関連付けを無視
		if (!remote || !App.users.has(remote)) {
			try {
				call.close();
			} catch (e) {}
			return;
		}
		if (!overrideRemoteUid && remote === Identity.id) {
			try {
				call.close();
			} catch (e) {}
			return;
		}
		// 同一相手との古い接続が残っている場合は、取り違えてstopVoiceWithが
		// 新しい接続を巻き添えで破棄しないよう、明示的に古い接続を切ってから差し替える
		const existing = App.voiceConns.get(remote);
		if (existing && existing !== call) {
			try {
				existing.off && existing.off('close');
				existing.off && existing.off('error');
			} catch (e) {}
			try {
				existing.close();
			} catch (e) {}
		}
		App.voiceConns.set(remote, call);
		call.on('stream', (stream) => {
			// 既存要素を使い回すと srcObject の切替時にブラウザが音声トラックを
			// 正しく再接続できない場合があるため、常に新しい要素を生成する
			const old = App.mediaEls.get(remote);
			if (old) {
				try { old.srcObject = null; } catch (e) {}
				old.remove();
			}
			// 旧 Web Audio コンテキストが残っていれば閉じる
			if (App._audioProcessors && App._audioProcessors.has(remote)) {
				try { App._audioProcessors.get(remote).ctx.close(); } catch (e) {}
				App._audioProcessors.delete(remote);
			}

			// audio 要素で直接再生する。
			// 以前は DynamicsCompressor を通すために Web Audio Graph 経由で
			// dest.stream を srcObject に設定していたが、AudioContext が
			// suspended 状態（ユーザー操作前）のまま ctx.resume() の完了を
			// 待つ間 dest.stream が無音になるため音声が聞こえない問題が発生した。
			// コンプレッサーは nice-to-have なので廃止し、ストリームを直接再生する。
			const el = document.createElement('audio');
			el.autoplay = true;
			// mediaPool が存在しない場合は body にフォールバック（DOMエラー防止）
			const pool = document.getElementById('mediaPool') || document.body;
			pool.appendChild(el);
			App.mediaEls.set(remote, el);
			el.srcObject = stream;
			applyMediaVolume(el, remote, 'voice');
			el.play().catch((e) => console.warn('Audio play failed', e));
			renderVoiceScreen();
		});
		call.on('close', () => {
			// 自分がすでに新しい接続に差し替え済みの場合は、
			// 古い接続のcloseイベントで新しい接続を消してしまわないようにする
			if (App.voiceConns.get(remote) === call) stopVoiceWith(remote);
		});
		call.on('error', () => {
			if (App.voiceConns.get(remote) === call) stopVoiceWith(remote);
		});
	}
	function bindScreenCall(call) {
		const remote = call.metadata && call.metadata.uid;
		if (!remote || !App.users.has(remote)) {
			try {
				call.close();
			} catch (e) {}
			return;
		}
		if (remote !== Identity.id) {
			const existing = App.screenConns.get(remote);
			if (existing && existing !== call) {
				try {
					existing.off && existing.off('close');
					existing.off && existing.off('error');
				} catch (e) {}
				try {
					existing.close();
				} catch (e) {}
			}
			// イベントハンドラより先に登録（close/errorが先に発火した場合の取り違え防止）
			App.screenConns.set(remote, call);
		}
		call.on('stream', (stream) => {
			if (remote === Identity.id) return;
			// 既存要素があればsrcObjectだけ差し替えて使い回す。
			// 要素を破棄→再生成すると間にsrcObject=nullが挟まり一瞬黒くなるため。
			// ただし既存要素のsrcObjectと同一ストリームでない場合のみ差し替える。
			let el = App.screenMediaEls.get(remote);
			if (el) {
				if (el.srcObject !== stream) {
					el.srcObject = stream;
					el.play().catch((e) => console.warn('Screen play failed', e));
				}
			} else {
				el = document.createElement('video');
				el.autoplay = true;
				el.playsInline = true;
				const pool = document.getElementById('mediaPool') || document.body;
				pool.appendChild(el);
				App.screenMediaEls.set(remote, el);
				el.srcObject = stream;
				el.play().catch((e) => console.warn('Screen play failed', e));
			}
			applyMediaVolume(el, remote, 'screen');
			renderVoiceScreen();
		});
		call.on('close', () => {
			if (App.screenConns.get(remote) === call) stopScreenWith(remote);
		});
		call.on('error', () => {
			if (App.screenConns.get(remote) === call) stopScreenWith(remote);
		});
	}
	function stopVoiceWith(theUid) {
		if (App.voiceConns.has(theUid)) {
			try {
				App.voiceConns.get(theUid).close();
			} catch (e) {}
			App.voiceConns.delete(theUid);
		}
		// Web Audio API 処理コンテキストのクリーンアップ
		if (App._audioProcessors && App._audioProcessors.has(theUid)) {
			try {
				App._audioProcessors.get(theUid).ctx.close();
			} catch (e) {}
			App._audioProcessors.delete(theUid);
		}
		if (App.mediaEls.has(theUid)) {
			const el = App.mediaEls.get(theUid);
			// ブラウザがストリームを保持し続けないよう srcObject を先に解放
			try {
				el.srcObject = null;
			} catch (e) {}
			el.remove();
			App.mediaEls.delete(theUid);
		}
		if (App.videoSenders) App.videoSenders.delete(theUid);
		cleanupSpeakingMonitor(theUid, 'voice');
		renderVoiceScreen();
	}
	function stopScreenWith(theUid) {
		if (App.screenConns.has(theUid)) {
			try {
				App.screenConns.get(theUid).close();
			} catch (e) {}
			App.screenConns.delete(theUid);
		}
		if (App.screenMediaEls.has(theUid)) {
			const el = App.screenMediaEls.get(theUid);
			try {
				el.srcObject = null;
			} catch (e) {}
			el.remove();
			App.screenMediaEls.delete(theUid);
		}
		cleanupSpeakingMonitor(theUid, 'screen');
		renderVoiceScreen();
	}

	/* ===================== ボイスチャット参加モーダル ===================== */
	async function populateVoiceDeviceSelects() {
		const micSel = document.getElementById('vjMicSelect');
		const camSel = document.getElementById('vjCamSelect');
		if (!micSel || !camSel) return;
		micSel.innerHTML = '<option value="">デフォルトマイク</option>';
		camSel.innerHTML = '<option value="">デフォルトカメラ</option>';
		try {
			const devices = await navigator.mediaDevices.enumerateDevices();
			let micCount = 1;
			let camCount = 1;
			devices.forEach((d) => {
				if (d.kind === 'audioinput') {
					const opt = document.createElement('option');
					opt.value = d.deviceId;
					opt.textContent = d.label || `マイク ${micCount++}`;
					micSel.appendChild(opt);
				} else if (d.kind === 'videoinput') {
					const opt = document.createElement('option');
					opt.value = d.deviceId;
					opt.textContent = d.label || `カメラ ${camCount++}`;
					camSel.appendChild(opt);
				}
			});
		} catch (e) {
			console.warn('デバイス列挙に失敗', e);
		}
	}

	async function openVoiceJoinModal() {
		const overlay = document.getElementById('ovVoiceJoin');
		const errEl = document.getElementById('vjErr');
		if (errEl) errEl.textContent = '';
		// モーダルオープン時にマイクとカメラの許可を求める（両方）
		try {
			const tmp = await navigator.mediaDevices.getUserMedia({
				audio: true,
				video: true,
			});
			tmp.getTracks().forEach((t) => t.stop());
		} catch (e) {
			// 片方だけ許可された場合も続行（enumerateで利用可能デバイスを確認）
			console.log('getUserMedia (both) partial or denied:', e && e.name);
		}
		await populateVoiceDeviceSelects();
		// 前回の設定を復元（なければデフォルト: マイク無効、カメラ無効）
		const micChk = document.getElementById('vjMicEnable');
		const camChk = document.getElementById('vjCamEnable');
		const savedPref = (() => {
			try {
				const s = localStorage.getItem('nc_voice_pref');
				return s ? JSON.parse(s) : null;
			} catch (e) {
				return null;
			}
		})();
		if (micChk) micChk.checked = savedPref ? !!savedPref.mic : false;
		if (camChk) camChk.checked = savedPref ? !!savedPref.cam : false;
		openOverlay('ovVoiceJoin');
	}

	function closeVoiceJoinModal() {
		closeOverlay('ovVoiceJoin', { noHistoryBack: true });
	}

	async function doJoinVoiceChatWithDevices(opts = {}) {
		if (App.localStream || !App.connected) return;
		const useMic = opts.audio !== false;
		const useCam = !!opts.video;
		const audioConstraint = useMic
			? {
					deviceId: opts.audioDeviceId ? { exact: opts.audioDeviceId } : undefined,
					echoCancellation: true,
					noiseSuppression: true,
					autoGainControl: true,
					// 音質向上: 48kHz / モノラル / 低レイテンシ
					sampleRate: { ideal: 48000 },
					channelCount: { ideal: 1 },
					latency: { ideal: 0 },
				}
			: false;
		const videoConstraint = useCam
			? opts.videoDeviceId
				? { deviceId: { exact: opts.videoDeviceId } }
				: true
			: false;
		if (audioConstraint || videoConstraint) {
			try {
				App.localStream = await navigator.mediaDevices.getUserMedia({
					audio: audioConstraint,
					video: videoConstraint,
				});
			} catch (e) {
				toast('選択したデバイスを取得できませんでした');
				return;
			}
		} else {
			// マイク・カメラ両方無効 → 空のストリームで参加
			App.localStream = new MediaStream();
		}
		// SDPにビデオm-lineを確保するためダミートラックを追加（カメラ無効時も）
		const hasRealVideo = App.localStream
			.getVideoTracks()
			.some((t) => t.readyState === 'live' && t.enabled && !t._isDummy);
		if (!hasRealVideo) {
			try {
				const dummyCanvas = document.createElement('canvas');
				dummyCanvas.width = 2;
				dummyCanvas.height = 2;
				const dummyCtx = dummyCanvas.getContext('2d');
				dummyCtx.fillRect(0, 0, 2, 2);
				const dummyStream = dummyCanvas.captureStream(0);
				const dummyTrack = dummyStream.getVideoTracks()[0];
				if (dummyTrack) {
					dummyTrack._isDummy = true;
					dummyTrack.enabled = false;
					App.localStream.addTrack(dummyTrack);
				}
			} catch (e) {}
		} else {
			App.cameraOn = true;
		}

		// SDPにオーディオm-lineを確保するためダミートラックを追加（マイク無効時も）
		const hasRealAudio = App.localStream
			.getAudioTracks()
			.some((t) => t.readyState === 'live' && t.enabled && !t._isDummy);
		if (!hasRealAudio) {
			try {
				const Ctx = window.AudioContext || window.webkitAudioContext;
				if (Ctx) {
					const actx = new Ctx();
					const dest = actx.createMediaStreamDestination();
					const dummyAudioTrack = dest.stream.getAudioTracks()[0];
					if (dummyAudioTrack) {
						dummyAudioTrack._isDummy = true;
						dummyAudioTrack.enabled = false;
						App.localStream.addTrack(dummyAudioTrack);
						App._dummyAudioContext = actx;
					}
				}
			} catch (e) {}
		}

		// マイク無効で参加した場合はミュート状態として扱う
		App.muted = !useMic;
		// 同一ユーザーの別デバイス強制切断（署名付き）
		const vtTs = Date.now();
		const vtPeerId = App.peer ? App.peer.id : null;
		const vtSignable = {
			k: 'voice-take',
			uid: Identity.id,
			roomId: App.roomId,
			ts: vtTs,
			peerId: vtPeerId,
		};
		const vtSig = await signPayload(vtSignable);
		distributeSys({
			t: 'sys',
			sub: 'voice-take',
			payload: {
				uid: Identity.id,
				peerId: vtPeerId,
				ts: vtTs,
				pub: Identity.pubJwk,
				sig: vtSig,
			},
		});

		await setOwnVoiceOption({ inVoice: true, cameraOn: App.cameraOn });

		Array.from(App.users.values())
			.filter((u) => u.uid !== Identity.id && u.inVoice)
			.forEach((u) => {
				callUser(u.uid);
				if (App.screenOn) callScreenUser(u.uid);
			});

		attachSpeakingMonitor(Identity.id, App.localStream, 'voice');
		startMediaBufferMonitor();
		if (App.captionsOn) {
			startSpeechRecognition();
			startCaptionDotTimer();
		}
		const jbtn = document.getElementById('vcJoinBtn');
		if (jbtn) jbtn.style.display = 'none';
		renderVoiceScreen();
		requestWakeLock();
	}

	async function joinVoiceChat() {
		// 後方互換・自動参加用（マイクのみ・デフォルトデバイス）
		if (App.localStream || !App.connected) return;
		try {
			App.localStream = await navigator.mediaDevices.getUserMedia({
				audio: {
					echoCancellation: true,
					noiseSuppression: true,
					autoGainControl: true,
					sampleRate: { ideal: 48000 },
					channelCount: { ideal: 1 },
					latency: { ideal: 0 },
				},
				video: false,
			});
		} catch (e) {
			toast('マイクを取得できませんでした');
			return;
		}
		// SDP に最初からビデオ m-line を確保するため、無効化した
		// ダミービデオトラックを追加しておく。これにより toggleCamera 時の
		// replaceTrack が必ず成功し、needsRecall による再接続が不要になる。
		try {
			const dummyCanvas = document.createElement('canvas');
			dummyCanvas.width = 2;
			dummyCanvas.height = 2;
			const dummyCtx = dummyCanvas.getContext('2d');
			dummyCtx.fillRect(0, 0, 2, 2);
			const dummyStream = dummyCanvas.captureStream(0);
			const dummyTrack = dummyStream.getVideoTracks()[0];
			if (dummyTrack) {
				dummyTrack._isDummy = true;
				dummyTrack.enabled = false;
				App.localStream.addTrack(dummyTrack);
			}
		} catch (e) {
			// ダミートラック作成失敗は無視（カメラ自体は後で再接続パスで動く）
		}
		// 同一ユーザーの別ウィンドウ/別デバイスが既にボイスチャットに
		// 参加している場合は、そちらを切断させて単一デバイスに限定する
		// (ユーザー固有の強制操作のため、署名を付与して認証を徹底する)
		const vtTs = Date.now();
		const vtPeerId = App.peer ? App.peer.id : null;
		const vtSignable = {
			k: 'voice-take',
			uid: Identity.id,
			roomId: App.roomId,
			ts: vtTs,
			peerId: vtPeerId,
		};
		const vtSig = await signPayload(vtSignable);
		distributeSys({
			t: 'sys',
			sub: 'voice-take',
			payload: {
				uid: Identity.id,
				peerId: vtPeerId,
				ts: vtTs,
				pub: Identity.pubJwk,
				sig: vtSig,
			},
		});

		await setOwnVoiceOption({ inVoice: true, cameraOn: App.cameraOn });

		Array.from(App.users.values())
			.filter((u) => u.uid !== Identity.id && u.inVoice)
			.forEach((u) => {
				callUser(u.uid);
				if (App.screenOn) callScreenUser(u.uid);
			});

		attachSpeakingMonitor(Identity.id, App.localStream, 'voice');
		startMediaBufferMonitor();
		if (App.captionsOn) {
			startSpeechRecognition();
			startCaptionDotTimer();
		}
		document.getElementById('vcJoinBtn').style.display = 'none';
		renderVoiceScreen();
		requestWakeLock();
	}
	// 再接続後にボイスチャットへ自動復帰する共通処理。
	// nc_voice_pref に保存された最後のデバイス設定を使って参加する。
	function rejoinVoiceAfterReconnect() {
		App._wasInVoice = false;
		let pref = {};
		try {
			const s = localStorage.getItem('nc_voice_pref');
			if (s) pref = JSON.parse(s);
		} catch (e) {}
		doJoinVoiceChatWithDevices({
			audio: pref.mic !== false,   // 未保存時はマイク有効をデフォルトとする
			video: !!pref.cam,
			audioDeviceId: pref.audioDeviceId || undefined,
			videoDeviceId: pref.videoDeviceId || undefined,
		});
	}

	/* ===================== speech recognition (字幕用音声認識) ===================== */

	function startSpeechRecognition() {
		const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
		if (!SR) return;
		// 既に起動中なら何もしない
		if (App._sr) return;
		// 再起動タイマーが残っていればキャンセル
		if (App._srRestartTimer) {
			clearTimeout(App._srRestartTimer);
			App._srRestartTimer = null;
		}

		const sr = new SR();
		sr.lang = 'ja-JP';
		sr.continuous = true;
		sr.interimResults = true;
		App._sr = sr;

		sr.onresult = (e) => {
			let interim = '';
			let final = '';
			for (let i = e.resultIndex; i < e.results.length; i++) {
				const t = e.results[i][0].transcript;
				if (e.results[i].isFinal) final += t;
				else interim += t;
			}
			const text = final || interim;
			if (!text) return;
			const isFinal = !!final;
			const now = Date.now();
			App.captions.set(Identity.id, { text, ts: now });
			// interim 中は自分のタイピングドットを立てる、確定したら消す
			if (isFinal) {
				App._captionTyping.delete(Identity.id);
			} else {
				App._captionTyping.set(Identity.id, true);
			}
			if (App.captionsOn) renderVoiceScreen();
			distributeSys({
				t: 'sys',
				sub: 'voice-caption',
				payload: { uid: Identity.id, text, ts: now, isFinal },
			});
		};

		// onerror が「権限なし」か「意図的中断」で再起動を禁止する場合に
		// onend へ伝えるためのフラグ（sr ローカル変数と同期する）
		let _srNoRestart = false;

		sr.onerror = (e) => {
			App._sr = null;
			if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
				// 権限エラー: マイク許可が得られていない。再起動しても無意味なので
				// onend でも再起動しないよう禁止フラグを立てる
				_srNoRestart = true;
				return;
			}
			// aborted は stopSpeechRecognition() から意図的に発火するので再起動しない
			if (e.error === 'aborted') {
				_srNoRestart = true;
				return;
			}
			// その他のエラー（no-speech, network, audio-capture 等）は少し待って再起動。
			// onend も直後に発火するが、App._srRestartTimer が既にセット済みであれば
			// onend 側では新たなタイマーを立てない（二重タイマー防止）。
			if (App.localStream && App.captionsOn) {
				App._srRestartTimer = setTimeout(() => {
					App._srRestartTimer = null;
					if (App.localStream && App.captionsOn) startSpeechRecognition();
				}, 1500);
			}
		};

		sr.onend = () => {
			// onerror が先に App._sr を null にしていない場合にここでリセット
			App._sr = null;
			// 権限エラー/意図的中断の場合は再起動しない
			if (_srNoRestart) return;
			// onerror が既に再起動タイマーをセットしていれば二重タイマーを避ける
			if (App._srRestartTimer) return;
			// ボイスチャット中かつ字幕ONなら自動再起動
			if (App.localStream && App.captionsOn) {
				App._srRestartTimer = setTimeout(() => {
					App._srRestartTimer = null;
					if (App.localStream && App.captionsOn) startSpeechRecognition();
				}, 300);
			}
		};

		try {
			sr.start();
		} catch (e) {
			App._sr = null;
		}
	}

	function stopSpeechRecognition() {
		if (App._srRestartTimer) {
			clearTimeout(App._srRestartTimer);
			App._srRestartTimer = null;
		}
		if (App._sr) {
			try { App._sr.abort(); } catch (e) {}
			App._sr = null;
		}
	}

	/* ===================== caption typing dots animation ===================== */

	// ドットフェーズ: 0='.', 1='..', 2='...' を 500ms 毎に進める
	// renderVoiceScreen から参照するため tick 単位で管理
	let _captionDotPhase = 0;

	// 字幕テキスト（タイピングドット込み）を組み立てる。
	// renderVoiceScreen と _captionDotTick の両方から呼ばれる共通ロジック。
	function buildCaptionText(realUid) {
		const cap = App.captions.get(realUid);
		if (cap) {
			const isStale = (Date.now() - cap.ts) > APP_CAPTION_TTL_MS;
			const isTyping = App._captionTyping.has(realUid) && !isStale;
			return {
				text: cap.text + (isTyping ? captionDotStr() : ''),
				stale: isStale,
			};
		}
		const isTyping = App._captionTyping.has(realUid);
		return {
			text: isTyping
				? '発言を待っています' + captionDotStr()
				: '発言を待っています...',
			stale: false,
		};
	}

	function _captionDotTick() {
		if (!App.captionsOn || !App.localStream) return;
		_captionDotPhase = (_captionDotPhase + 1) % 3;
		// 画面共有中の video 要素ごと再構築する renderVoiceScreen() は重く、
		// 共有画面視聴側でちらつきの原因になるため、ここでは既存の
		// .pCaption 要素のテキストだけをピンポイントで差分更新する。
		document.querySelectorAll('.pCaption[data-caption-uid]').forEach((el) => {
			const realUid = el.dataset.captionUid;
			const { text, stale } = buildCaptionText(realUid);
			el.textContent = text;
			el.style.opacity = stale ? '0.4' : '';
		});
	}

	function startCaptionDotTimer() {
		stopCaptionDotTimer();
		_captionDotPhase = 0;
		App._captionDotTimer = setInterval(_captionDotTick, 500);
	}

	function stopCaptionDotTimer() {
		if (App._captionDotTimer) {
			clearInterval(App._captionDotTimer);
			App._captionDotTimer = null;
		}
	}

	// 現在のフェーズに対応するドット文字列を返す（副作用なし）
	function captionDotStr() {
		return _captionDotPhase === 0 ? '.' : _captionDotPhase === 1 ? '..' : '...';
	}

	function leaveVoiceChat() {
		releaseWakeLock();
		// バッファモニターを停止（退出後も動き続けるのを防ぐ）
		if (App.bufferMonitorTimer) {
			clearInterval(App.bufferMonitorTimer);
			App.bufferMonitorTimer = null;
		}
		if (App._bufStats) App._bufStats.clear();
		if (App._bufWarnCooldown) App._bufWarnCooldown = 0;
		if (App._bufferWarned) App._bufferWarned = false;
		if (App._dummyAudioContext) {
			try { App._dummyAudioContext.close(); } catch (e) {}
			App._dummyAudioContext = null;
		}
		// 受信音声の Web Audio API 処理コンテキストをすべてクリーンアップ
		if (App._audioProcessors) {
			App._audioProcessors.forEach((proc) => {
				try { proc.ctx.close(); } catch (e) {}
			});
			App._audioProcessors.clear();
		}
		if (App.localStream) {
			App.localStream.getTracks().forEach((t) => t.stop());
			App.localStream = null;
		}
		if (App.screenStream) {
			App.screenStream.getTracks().forEach((t) => t.stop());
			App.screenStream = null;
		}
		App.voiceConns.forEach((c) => {
			try {
				c.close();
			} catch (e) {}
		});
		App.voiceConns.clear();
		if (App.videoSenders) App.videoSenders.clear();

		App.screenConns.forEach((c) => {
			try {
				c.close();
			} catch (e) {}
		});
		App.screenConns.clear();

		App.myScreenCalls.forEach((c) => {
			try {
				c.close();
			} catch (e) {}
		});
		App.myScreenCalls.clear();

		App.mediaEls.forEach((el) => {
			try {
				el.srcObject = null;
			} catch (e) {}
			el.remove();
		});
		App.mediaEls.clear();

		App.screenMediaEls.forEach((el) => {
			try {
				el.srcObject = null;
			} catch (e) {}
			el.remove();
		});
		App.screenMediaEls.clear();

		// 自分自身の発話モニターとリモートユーザーの speaking 状態を全クリア
		cleanupSpeakingMonitor(Identity.id, 'voice');
		cleanupSpeakingMonitor(Identity.id, 'screen');
		App.speakingState.clear();
		App.speakingMonitors.forEach((mon) => {
			if (mon.timer) clearInterval(mon.timer);
			try { mon.ctx && mon.ctx.close && mon.ctx.close(); } catch (e) {}
		});
		App.speakingMonitors.clear();

		App.cameraOn = false;
		App.screenOn = false;
		App.muted = false;
		App.captions.clear();
		App._captionTyping.clear();
		stopSpeechRecognition();
		stopCaptionDotTimer();
		featuredUid = null;
		// B4 fix: VC 離脱時に進行中の TTS 読み上げをキャンセルする
		if (typeof speechSynthesis !== 'undefined' && speechSynthesis.cancel) {
			try { speechSynthesis.cancel(); } catch (e) {}
		}

		setOwnVoiceOption({ inVoice: false, cameraOn: false });

		const j = document.getElementById('vcJoinBtn');
		if (j) j.style.display = 'inline-block';

		if (isMobile) {
			setChatOpen(false);
		}

		renderVoiceScreen();
		renderVoiceToolbar();
	}
	async function requestWakeLock() {
		if (!('wakeLock' in navigator)) return;
		try {
			if (App.wakeLockSentinel) return;
			App.wakeLockSentinel = await navigator.wakeLock.request('screen');
			App.wakeLockSentinel.addEventListener('release', () => {
				App.wakeLockSentinel = null;
			});
		} catch (err) {
			console.error('Failed to request wake lock:', err);
		}
	}
	async function releaseWakeLock() {
		if (App.wakeLockSentinel) {
			try {
				await App.wakeLockSentinel.release();
			} catch (err) {
				console.error('Failed to release wake lock:', err);
			}
			App.wakeLockSentinel = null;
		}
	}
	document.addEventListener('visibilitychange', async () => {
		if (document.visibilityState === 'visible' && App.localStream) {
			await requestWakeLock();
		}
	});
	async function toggleMute() {
		if (!App.localStream) return;
		const audioTracks = App.localStream.getAudioTracks();
		const hasRealAudio = audioTracks.some((t) => !t._isDummy);
		if (!hasRealAudio) {
			// マイク無効で参加した → 初めてマイクを有効にする
			// 送信を確実にするため、sender が見つからない場合は再接続（recall）する
			try {
				const s = await navigator.mediaDevices.getUserMedia({
					audio: {
						echoCancellation: true,
						noiseSuppression: true,
						autoGainControl: true,
						sampleRate: { ideal: 48000 },
						channelCount: { ideal: 1 },
						latency: { ideal: 0 },
					},
				});
				const track = s.getAudioTracks()[0];
				if (!track) {
					toast('マイクを取得できませんでした');
					return;
				}
				// 古いダミートラックがあれば停止して削除
				audioTracks.forEach((t) => {
					if (t._isDummy) {
						t.stop();
						App.localStream.removeTrack(t);
					}
				});
				App.localStream.addTrack(track);

				const needsRecall = [];
				App.voiceConns.forEach((call, remoteUid) => {
					const pc = call.peerConnection;
					if (!pc) return;
					let sender = pc
						.getSenders()
						.find((s) => s.track && s.track.kind === 'audio');
					if (
						sender &&
						pc.getSenders &&
						pc.getSenders().includes(sender)
					) {
						sender
							.replaceTrack(track)
							.catch(() => needsRecall.push(remoteUid));
					} else {
						needsRecall.push(remoteUid);
					}
				});

				App.muted = false;
				track.onended = () => {
					App.muted = true;
					try {
						const prev = JSON.parse(
							localStorage.getItem('nc_voice_pref') || '{}',
						);
						localStorage.setItem(
							'nc_voice_pref',
							JSON.stringify({ ...prev, mic: false }),
						);
					} catch (e) {}
					renderVoiceToolbar();
				};

				// sender が見つからなかった（初回マイク無効参加など）は再接続してSDPを更新
				if (needsRecall.length > 0) {
					needsRecall.forEach((remoteUid) => {
						try {
							const old = App.voiceConns.get(remoteUid);
							if (old) {
								try {
									old.off && old.off('close');
									old.off && old.off('error');
								} catch (e) {}
								try {
									old.close();
								} catch (e) {}
							}
						} catch (e) {}
						App.voiceConns.delete(remoteUid);
						if (App.videoSenders)
							App.videoSenders.delete(remoteUid);
						callUser(remoteUid);
					});
				}

				// 発話モニターも更新（新しい音声トラックを拾う）
				cleanupSpeakingMonitor(Identity.id, 'voice');
				attachSpeakingMonitor(Identity.id, App.localStream, 'voice');

				// 設定保存
				try {
					const prev = JSON.parse(
						localStorage.getItem('nc_voice_pref') || '{}',
					);
					localStorage.setItem(
						'nc_voice_pref',
						JSON.stringify({ ...prev, mic: true }),
					);
				} catch (e) {}
			} catch (e) {
				toast('マイクを取得できませんでした');
				return;
			}
		} else {
			// トラックあり → 通常のミュートトグル
			App.muted = !App.muted;
			audioTracks.forEach((t) => (t.enabled = !App.muted));
			try {
				const prev = JSON.parse(
					localStorage.getItem('nc_voice_pref') || '{}',
				);
				localStorage.setItem(
					'nc_voice_pref',
					JSON.stringify({ ...prev, mic: !App.muted }),
				);
			} catch (e) {}
		}
		renderVoiceToolbar();
	}
	async function setLocalVideoTrack(track) {
		if (!App.localStream) return;
		if (!App.videoSenders) App.videoSenders = new Map();

		let finalTrack = track;
		if (!finalTrack) {
			try {
				const dummyCanvas = document.createElement('canvas');
				dummyCanvas.width = 2;
				dummyCanvas.height = 2;
				const dummyCtx = dummyCanvas.getContext('2d');
				dummyCtx.fillRect(0, 0, 2, 2);
				const dummyStream = dummyCanvas.captureStream(0);
				const dummyTrack = dummyStream.getVideoTracks()[0];
				if (dummyTrack) {
					dummyTrack._isDummy = true;
					dummyTrack.enabled = false;
					finalTrack = dummyTrack;
				}
			} catch (e) {}
		}

		// ① PeerConnection の video sender を先に replaceTrack する
		//    （stream から removeTrack すると sender.track が null になり
		//      sender が二度と検出できなくなるため、順序が重要）
		const needsRecall = [];
		App.voiceConns.forEach((call, remoteUid) => {
			const pc = call.peerConnection;
			if (!pc) return;
			let sender = App.videoSenders.get(remoteUid);
			if (sender && pc.getSenders && !pc.getSenders().includes(sender))
				sender = null;
			if (!sender && pc.getSenders) {
				const allSenders = pc.getSenders();
				sender = allSenders.find(
					(s) => s.track && s.track.kind === 'video',
				);
				if (!sender) {
					try {
						if (pc.getTransceivers) {
							const vtc = pc
								.getTransceivers()
								.find(
									(tc) =>
										tc.sender &&
										allSenders.includes(tc.sender) &&
										tc.receiver &&
										tc.receiver.track &&
										tc.receiver.track.kind === 'video',
								);
							if (vtc) sender = vtc.sender;
						}
					} catch (e) {}
				}
				if (!sender) {
					const nullSenders = allSenders.filter(
						(s) => s.track === null,
					);
					if (nullSenders.length === 1) sender = nullSenders[0];
				}
			}
			if (finalTrack) {
				if (sender) {
					sender
						.replaceTrack(finalTrack)
						.then(() => App.videoSenders.set(remoteUid, sender))
						.catch(() => needsRecall.push(remoteUid));
				} else {
					needsRecall.push(remoteUid);
				}
			}
		});

		// ② stream 上のビデオトラックを置き換え
		App.localStream.getVideoTracks().forEach((t) => {
			App.localStream.removeTrack(t);
			t.stop();
		});
		if (finalTrack) App.localStream.addTrack(finalTrack);

		// ③ senderが見つからなかった相手には再接続で映像を届ける
		if (track && needsRecall.length > 0) {
			needsRecall.forEach((remoteUid) => {
				try {
					const old = App.voiceConns.get(remoteUid);
					if (old) {
						try {
							old.off && old.off('close');
							old.off && old.off('error');
						} catch (e) {}
						try {
							old.close();
						} catch (e) {}
					}
				} catch (e) {}
				App.voiceConns.delete(remoteUid);
				App.videoSenders.delete(remoteUid);
				callUser(remoteUid);
			});
		}
		if (!track) App.cameraOn = false;
		renderVoiceScreen();
	}
	async function toggleCamera() {
		if (!App.localStream) return;
		if (App.cameraOn) {
			await setLocalVideoTrack(null);
			App.cameraOn = false;
			setOwnVoiceOption({ cameraOn: false });
		} else {
			try {
				const s = await navigator.mediaDevices.getUserMedia({
					video: true,
				});
				const track = s.getVideoTracks()[0];
				await setLocalVideoTrack(track);
				App.cameraOn = true;
				setOwnVoiceOption({ cameraOn: true });
				track.onended = () => {
					App.cameraOn = false;
					setLocalVideoTrack(null);
					setOwnVoiceOption({ cameraOn: false });
					// カメラが外部要因で切れた場合も保存
					try {
						const prev = JSON.parse(
							localStorage.getItem('nc_voice_pref') || '{}',
						);
						localStorage.setItem(
							'nc_voice_pref',
							JSON.stringify({ ...prev, cam: false }),
						);
					} catch (e) {}
					renderVoiceToolbar();
					renderVoiceScreen();
				};
			} catch (e) {
				toast('カメラを取得できませんでした');
			}
		}
		// カメラのON/OFFを次回モーダル用に保存
		try {
			const prev = JSON.parse(
				localStorage.getItem('nc_voice_pref') || '{}',
			);
			localStorage.setItem(
				'nc_voice_pref',
				JSON.stringify({ ...prev, cam: App.cameraOn }),
			);
		} catch (e) {}
		renderVoiceToolbar();
	}
	async function toggleScreenShare() {
		if (!App.localStream) return;
		if (App.screenOn) {
			// 先にフラグを落とす（vTrack.onended からの再帰呼び出し防止）
			App.screenOn = false;
			if (App.screenStream) {
				App.screenStream.getTracks().forEach((t) => t.stop());
				App.screenStream = null;
			}
			App.screenConns.forEach((c) => {
				try {
					c.close();
				} catch (e) {}
			});
			App.screenConns.clear();
			App.myScreenCalls.forEach((c) => {
				try {
					c.close();
				} catch (e) {}
			});
			App.myScreenCalls.clear();
			cleanupSpeakingMonitor(Identity.id, 'screen');
			renderVoiceToolbar();
			renderVoiceScreen();
		} else {
			try {
				const s = await navigator.mediaDevices.getDisplayMedia({
					video: true,
					audio: true,
				});
				App.screenStream = s;
				App.screenOn = true;
				attachSpeakingMonitor(Identity.id, App.screenStream, 'screen');

				Array.from(App.users.values())
					.filter((u) => u.uid !== Identity.id && u.inVoice)
					.forEach((u) => callScreenUser(u.uid));

				const vTrack = s.getVideoTracks()[0];
				if (vTrack) {
					vTrack.onended = () => {
						if (App.screenOn) toggleScreenShare();
					};
					// 共有中にウィンドウのリサイズ等でキャプチャ解像度が変化した際、
					// ブラウザ側のエンコーダは自動的に新しい解像度へ追従するが、
					// 自分のプレビュー表示（アスペクト比に依存するUI要素）を
					// 最新の状態に合わせて再描画する。
					// なお onresize は輻輳制御等によるエンコーダの自動解像度調整でも
					// 短時間に連発することがあるため、重い renderVoiceScreen() の
					// 呼び出し過多でちらつかないようデバウンスする。
					let _screenResizeTimer = null;
					vTrack.onresize = () => {
						if (!App.screenOn) return;
						clearTimeout(_screenResizeTimer);
						_screenResizeTimer = setTimeout(() => {
							if (App.screenOn) renderVoiceScreen();
						}, 400);
					};
				}
				renderVoiceToolbar();
				renderVoiceScreen();
			} catch (e) {}
		}
	}

	/* ===================== rendering: room list ===================== */

	function renderRoomList() {
		const box = document.getElementById('roomList');
		box.innerHTML = '';
		const persisted = RoomStore.list();
		const items = persisted.slice();
		if (App.ephemeral && !items.find((r) => r.id === App.ephemeral.id))
			items.unshift(App.ephemeral);
		const emptyEl = document.getElementById('sidebarEmpty');
		if (emptyEl) {
			emptyEl.style.display = items.length === 0 ? 'block' : 'none';
		}
		items.forEach((r) => {
			const el = document.createElement('div');
			el.className = 'roomItem' + (r.id === App.roomId ? ' active' : '');
			const dot = document.createElement('span');
			dot.className = 'ricon';
			const nm = document.createElement('span');
			nm.className = 'rname';
			nm.textContent = r.name || '無題のスペース';
			const tag = document.createElement('span');
			tag.className = 'rtag';
			tag.textContent = r.persist ? '' : '一時';
			el.appendChild(dot);
			el.appendChild(nm);
			el.appendChild(tag);
			el.onclick = () => {
				if (isMobile || isCompactPC()) setSidebarOpen(false);
				if (r.id === App.roomId && App.connected) return;
				openRoom(r.id, r.name, r.persist);
			};
			box.appendChild(el);
		});
	}

	/* ===================== rendering: header / users ===================== */

	function renderHeader() {
		let displayName = App.roomOption.name;
		if (!App.connected && (!displayName || displayName === '無題のスペース')) {
			displayName = 'Connecting...';
		}
		document.getElementById('headerName').textContent =
			displayName || '無題のスペース';
		document.getElementById('headerTag').textContent = App.roomOption
			.persist
			? '永続'
			: '一時';
		const visible = Array.from(App.users.values());
		document.getElementById('onlineBadge').textContent =
			visible.length + '人';
	}
	function renderUserPopover() {
		const ul = document.getElementById('userPopoverList');
		ul.innerHTML = '';
		if (!App.allMembers || App.allMembers.size === 0) {
			// fallback for compatibility
			App.users.forEach((u) => {
				const li = document.createElement('li');
				const av = document.createElement('span');
				av.className = 'avatar';
				av.style.width = '20px';
				av.style.height = '20px';
				av.style.fontSize = '9px';
				const deviceU = UserStore.get(u.uid);
				const displayU = deviceU
					? {
							...u,
							name: deviceU.name,
							image: deviceU.image,
						}
					: u;
				applyAvatarEl(av, displayU);
				let displayName = getDisplayName(displayU) || '名前なし';
				if (u.uid === Identity.id) displayName = '*' + displayName;
				const nm = document.createElement('span');
				nm.textContent = displayName;
				li.appendChild(av);
				li.appendChild(nm);
				ul.appendChild(li);
			});
			return;
		}
		const connectedUids = new Set(App.users.keys());
		const createUserLi = (u, isOffline) => {
			const li = document.createElement('li');
			if (isOffline) li.style.opacity = '0.55';
			li.title = u.uid || ''; // ホバーでID確認
			li.style.cursor = 'pointer';
			li.onclick = () => openUserModal && openUserModal(u.uid);
			const av = document.createElement('span');
			av.className = 'avatar';
			av.style.width = '20px';
			av.style.height = '20px';
			av.style.fontSize = '9px';
			// デバイス上のユーザーリストデータを優先して表示（name/imageの最新値）
			const deviceU = UserStore.get(u.uid);
			const displayU = deviceU
				? { ...u, name: deviceU.name, image: deviceU.image }
				: u;
			applyAvatarEl(av, displayU);
			let displayName = getDisplayName(displayU);
			if (u.uid === Identity.id) displayName = '*' + displayName;
			const nm = document.createElement('span');
			nm.textContent = displayName;
			li.appendChild(av);
			li.appendChild(nm);
			ul.appendChild(li);
		};
		// 上側: 接続中のユーザー
		Array.from(App.allMembers.values())
			.filter((u) => connectedUids.has(u.uid))
			.forEach((u) => createUserLi(u, false));
		// 下側: 未接続（過去参加）のユーザー
		const offlineList = Array.from(App.allMembers.values()).filter(
			(u) => !connectedUids.has(u.uid),
		);
		if (offlineList.length > 0) {
			const offHeader = document.createElement('li');
			offHeader.style.cssText =
				'font-size:10px;color:var(--sub);padding:4px 0 2px;list-style:none;';
			offHeader.textContent = 'オフライン';
			ul.appendChild(offHeader);
			offlineList.forEach((u) => createUserLi(u, true));
		}
	}

	/* ===================== ユーザーアクションモーダル ===================== */
	let currentUserModalUid = null;

	function getDisplayName(u) {
		if (!u) return '名前なし';
		const nick = App.userNicknames.get(u.uid);
		if (nick) return nick;
		return u.name || '名前なし';
	}

	function openUserModal(uid) {
		if (!uid) return;
		if (uid === Identity.id) return; // 自分自身の場合は無視
		currentUserModalUid = uid;
		const overlay = document.getElementById('ovUserModal');
		const title = document.getElementById('umTitle');
		const avEl = document.getElementById('umAvatar');
		const nameEl = document.getElementById('umName');
		const uidEl = document.getElementById('umUid');
		const nickInput = document.getElementById('umNickname');
		const muteChk = document.getElementById('umMute');

		const deviceU = UserStore.get(uid);
		const u = deviceU ||
			App.users.get(uid) ||
			App.allMembers.get(uid) || { uid, name: '不明' };

		title.textContent = 'ユーザー情報';
		applyAvatarEl(avEl, u);
		nameEl.textContent = getDisplayName(u) || '名前なし';
		uidEl.textContent = uid;
		uidEl.onclick = () => {
			navigator.clipboard
				.writeText(uid)
				.then(() => toast('IDをコピーしました'))
				.catch(() => toast(uid));
		};

		nickInput.value = App.userNicknames.get(uid) || '';
		nickInput.disabled = false;

		muteChk.checked = App.mutedUsers.has(uid);
		muteChk.disabled = false;

		const saveBtn = document.getElementById('umSave');
		const newSave = saveBtn.cloneNode(true);
		saveBtn.parentNode.replaceChild(newSave, saveBtn);
		newSave.onclick = () => {
			const newNick = nickInput.value.trim();
			if (newNick) {
				App.userNicknames.set(uid, newNick);
			} else {
				App.userNicknames.delete(uid);
			}
			if (muteChk.checked) App.mutedUsers.add(uid);
			else App.mutedUsers.delete(uid);
			// ミュート中のユーザーが送信したメッセージは同期しない + 自動で削除する
			if (muteChk.checked && uid) {
				let removed = false;
				for (const [id, m] of Array.from(App.messages.entries())) {
					if (m.uid === uid) {
						App.messages.delete(id);
						removed = true;
					}
				}
				if (removed) {
					persistIfNeeded();
				}
			}
			saveUserSettings();
			closeOverlay('ovUserModal', { noHistoryBack: true });
			if (pendingReopenSocial) {
				pendingReopenSocial = false;
				openOverlay('ovSocial', { noHistory: true });
			}
			renderLog();
			renderUserPopover();
			renderHeader();
			toast('設定を保存しました');
		};

		document.getElementById('umClose').onclick = () => {
			closeOverlay('ovUserModal', { noHistoryBack: true });
			if (pendingReopenSocial) {
				pendingReopenSocial = false;
				openOverlay('ovSocial', { noHistory: true });
			}
		};

		// ユーザー情報削除ボタン
		const deleteBtn = document.getElementById('umDelete');
		if (deleteBtn) {
			deleteBtn.onclick = async () => {
				if (!await showConfirm('このユーザーの情報を削除しますか?')) return;
				if (App.userNicknames.has(uid)) App.userNicknames.delete(uid);
				if (App.mutedUsers.has(uid)) App.mutedUsers.delete(uid);
				if (UserStore.data.has(uid)) {
					UserStore.data.delete(uid);
					UserStore.save();
				}
				saveUserSettings();
				closeOverlay('ovUserModal', {
					noHistoryBack: true,
				});
				if (pendingReopenSocial) {
					pendingReopenSocial = false;
					renderSocialList();
					openOverlay('ovSocial', { noHistory: true });
				}
				renderLog();
				renderUserPopover();
				renderHeader();
				renderRoomList();
				toast('ユーザー情報を削除しました');
			};
		}

		openOverlay('ovUserModal');
	}

	/* ===================== social (known users) modal ===================== */
	function renderSocialList() {
		const listEl = document.getElementById('socialList');
		if (!listEl) return;
		listEl.innerHTML = '';

		const all = Array.from(UserStore.data.values()).filter(
			(u) => u.uid !== Identity.id,
		);
		all.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

		const mutedList = all.filter((u) => App.mutedUsers.has(u.uid));
		const normalList = all.filter((u) => !App.mutedUsers.has(u.uid));

		function makeItem(u, isMutedSection) {
			const div = document.createElement('div');
			div.className = 'socialUserItem';
			if (isMutedSection) div.style.opacity = '0.55';

			const av = document.createElement('div');
			av.className = 'avatar';
			av.style.width = '28px';
			av.style.height = '28px';
			av.style.fontSize = '11px';
			applyAvatarEl(av, u);

			const info = document.createElement('div');
			info.style.flex = '1';
			const displayName = getDisplayName(u) || '名前なし';

			// XSS対策: innerHTMLの代わりにcreateElement + textContentを使用
			const nameDiv = document.createElement('div');
			nameDiv.className = 'suName';
			nameDiv.textContent = displayName;
			const subDiv = document.createElement('div');
			subDiv.className = 'suSub';
			subDiv.textContent = '#' + (u.uid || '').slice(0, 8);
			info.appendChild(nameDiv);
			info.appendChild(subDiv);

			div.appendChild(av);
			div.appendChild(info);

			if (u.uid !== Identity.id) {
				div.style.cursor = 'pointer';
				div.onclick = () => {
					closeOverlay('ovSocial', {
						noHistoryBack: true,
					});
					pendingReopenSocial = true;
					openUserModal(u.uid);
				};
			} else {
				div.onclick = () => {
					toast('自分自身の設定は左下のフッターから行えます');
				};
			}
			listEl.appendChild(div);
		}

		normalList.forEach((u) => makeItem(u, false));

		if (mutedList.length > 0) {
			if (normalList.length > 0) {
				const sep = document.createElement('div');
				sep.style.cssText =
					'height:1px; background:var(--line); margin:10px 4px;';
				listEl.appendChild(sep);
			}
			const header = document.createElement('div');
			header.style.cssText =
				'font-size:11px; color:var(--sub); padding:4px 4px 6px;';
			header.textContent = 'ミュート中';
			listEl.appendChild(header);
			mutedList.forEach((u) => makeItem(u, true));
		}

		if (all.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'socialEmpty';
			empty.textContent = 'まだ知っているユーザーがいません';
			listEl.appendChild(empty);
		}
	}

	function refreshSocialIfOpen() {
		const overlay = document.getElementById('ovSocial');
		if (overlay && overlay.classList.contains('show')) {
			renderSocialList();
		}
	}

	function openSocialModal() {
		const overlay = document.getElementById('ovSocial');
		if (!overlay) return;
		const listEl = document.getElementById('socialList');
		if (!listEl) return;
		renderSocialList();
		openOverlay('ovSocial');
	}

	/* ===================== rendering: voice screen ===================== */

	function renderVoiceToolbar() {
		const active = !!App.localStream;
		const tb = document.getElementById('voiceToolbar');
		tb.style.display = active ? 'flex' : 'none';

		const muteBtn = document.getElementById('vcMuteBtn');
		muteBtn.classList.toggle('active', !App.muted);
		muteBtn.dataset.tip = App.muted ? 'ミュート中' : 'マイク';

		document
			.getElementById('vcCamBtn')
			.classList.toggle('active', App.cameraOn);
		document
			.getElementById('vcShareBtn')
			.classList.toggle('active', App.screenOn);

		const capBtn = document.getElementById('vcCaptionBtn');
		capBtn.classList.toggle('active', App.captionsOn);
		capBtn.dataset.tip = App.captionsOn ? '字幕オン' : '字幕';

		const ttsBtn = document.getElementById('vcTtsBtn');
		ttsBtn.classList.toggle('active', App.ttsOn);
		ttsBtn.dataset.tip = App.ttsOn ? '読み上げオン' : '読み上げ';
	}

	const APP_CAPTION_TTL_MS = 30 * 1000; // B5 fix: 字幕の有効期間（30秒）

	let featuredUid = null;
	let prevVoiceActive = false;

	function renderVoiceScreen() {
		const active = !!App.localStream;
		document
			.getElementById('roomBody')
			.classList.toggle('voiceActive', active);
		renderVoiceToolbar();

		prevVoiceActive = active;
		if (!active) {
			if (App.mediaFullscreen) {
				closeMediaFullscreen();
			}
			return;
		}

		// VC参加者のみを抽出
		const voiceUsers = Array.from(App.users.values()).filter(
			(u) =>
				u.inVoice ||
				App.voiceConns.has(u.uid) ||
				(u.uid === Identity.id && App.localStream),
		);

		// 全画面表示中のストリームの生存チェック
		if (App.mediaFullscreen) {
			const fsUid = App.mediaFullscreen.uid;
			const fsKind = App.mediaFullscreen.kind;
			const userStillExists = voiceUsers.some((u) => u.uid === fsUid);
			let videoStillActive = false;
			if (userStillExists) {
				if (fsKind === 'screen') {
					const stream =
						fsUid === Identity.id
							? App.screenStream
							: (
									App.screenMediaEls.get(fsUid) || {
										srcObject: null,
									}
								).srcObject;
					videoStillActive =
						stream &&
						stream.getVideoTracks &&
						stream
							.getVideoTracks()
							.some((t) => t.readyState === 'live' && t.enabled);
				} else {
					videoStillActive =
						fsUid === Identity.id
							? App.cameraOn
							: !!voiceUsers.find((u) => u.uid === fsUid)?.cameraOn;
				}
			}
			if (!userStillExists || !videoStillActive) {
				closeMediaFullscreen();
			}
		}

		// 画面共有ユーザーを追加して displayUsers を構成
		const displayUsers = [];
		voiceUsers.forEach((u) => {
			displayUsers.push(u); // 本体

			if (
				(u.uid === Identity.id && App.screenOn) ||
				App.screenMediaEls.has(u.uid)
			) {
				displayUsers.push({
					...u,
					uid: u.uid + ':screen',
					name: (u.name || '名前なし') + ' - 画面共有',
					isScreenInfo: true,
					originalUid: u.uid,
				});
			}
		});

		const hasVideoUid = displayUsers.find((u) => {
			let isScreen = u.isScreenInfo;
			let realUid = isScreen ? u.originalUid : u.uid;
			if (isScreen) {
				// screenMediaEls/screenStream が存在する = 接続中なので映像あり扱い。
				// readyState は一時的に 'live' 以外になる場合があるため、
				// ストリームの存在のみで判定して黒画面への切り替えを防ぐ。
				if (realUid === Identity.id) return !!App.screenStream;
				const el = App.screenMediaEls.get(realUid);
				return !!(el && el.srcObject);
			} else {
				return realUid === Identity.id ? App.cameraOn : !!u.cameraOn;
			}
		});

		if (!featuredUid || !displayUsers.find((u) => u.uid === featuredUid)) {
			featuredUid = hasVideoUid
				? hasVideoUid.uid
				: displayUsers[0] && displayUsers[0].uid;
		}

		/* ---- メイン映像 ---- */
		const fv = document.getElementById('featuredVideo');
		// srcObjectを明示的にnullにしてからクリアしてメモリリークを防ぐ
		fv.querySelectorAll('video').forEach((v) => {
			v.srcObject = null;
		});
		fv.innerHTML = '';
		fv.classList.remove('speaking');
		fv.onclick = null;
		// speaking クラス差分更新のため識別子を付与
		delete fv.dataset.uid;
		delete fv.dataset.kind;
		const fu =
			displayUsers.find((u) => u.uid === featuredUid) || displayUsers[0];
		if (fu) {
			let isScreen = fu.isScreenInfo;
			let realUid = isScreen ? fu.originalUid : fu.uid;
			const fStream = isScreen
				? realUid === Identity.id
					? App.screenStream
					: (
							App.screenMediaEls.get(realUid) || {
								srcObject: null,
							}
						).srcObject
				: realUid === Identity.id
					? App.localStream
					: (
							App.mediaEls.get(realUid) || {
								srcObject: null,
							}
						).srcObject;

			// 画面共有: ストリームが存在するだけで映像あり扱い。
			// readyState が一時的に 'live' 以外になっても黒画面にしない。
			const fHasVideo = isScreen
				? (realUid === Identity.id
					? !!App.screenStream
					: !!(App.screenMediaEls.get(realUid)?.srcObject))
				: realUid === Identity.id
					? App.cameraOn
					: !!fu.cameraOn;
			if (fHasVideo) {
				const v = document.createElement('video');
				v.autoplay = true;
				v.playsInline = true;
				// 映像表示用のvideo要素は音声を二重に再生しないよう、自分・相手問わず常にミュート
				// （音声はバックグラウンドの mediaPool 内の要素で一元管理して再生します）
				v.muted = true;
				v.srcObject = fStream;
				fv.appendChild(v);
			} else {
				const av = document.createElement('div');
				av.className = 'featuredAvatar';
				applyAvatarEl(av, fu);
				fv.appendChild(av);
			}
			let labelName = fu.name || '名前なし';
			if (realUid === Identity.id && !isScreen)
				labelName = '*' + labelName;
			const lbl = document.createElement('div');
			lbl.id = 'featuredLabel';
			lbl.textContent = labelName;
			fv.appendChild(lbl);
			const featuredKind = isScreen ? 'screen' : 'voice';
			// speaking クラス差分更新のため識別子を付与
			fv.dataset.uid = realUid;
			fv.dataset.kind = featuredKind;
			const featuredSpeaking = isUserSpeaking(realUid, featuredKind);
			fv.classList.toggle('speaking', featuredSpeaking);
			if (fHasVideo && fStream) {
				fv.style.cursor = 'zoom-in';
				fv.onclick = () =>
					openMediaFullscreen({
						uid: realUid,
						kind: featuredKind,
						self: realUid === Identity.id,
						label: labelName,
						stream: fStream,
					});
				// ダブルクリックは全画面側の終了操作に使うので、ここでは単純クリックのみ
			} else {
				fv.style.cursor = 'default';
			}
		}

		/* ---- サムネイル行は廃止（participantListに統合） ---- */
		const thumb = document.getElementById('thumbRow');
		thumb.innerHTML = '';
		thumb.style.display = 'none';

		/* ---- 参加者リスト（サムネイル統合済み） ---- */
		const list = document.getElementById('participantList');
		list.querySelectorAll('video').forEach((v) => {
			v.srcObject = null;
		});
		list.innerHTML = '';
		displayUsers.forEach((u) => {
			let isScreen = u.isScreenInfo;
			let realUid = isScreen ? u.originalUid : u.uid;

			const row = document.createElement('div');
			const rowKind = isScreen ? 'screen' : 'voice';
			const rowSpeaking = isUserSpeaking(realUid, rowKind);
			row.className =
				'pRow' +
				(u.uid === featuredUid ? ' featured' : '') +
				(rowSpeaking ? ' speaking' : '');
			// speaking クラス差分更新のため識別子を付与
			row.dataset.uid = realUid;
			row.dataset.kind = rowKind;
			row.onclick = () => {
				featuredUid = u.uid;
				renderVoiceScreen();
			};

			const top = document.createElement('div');
			top.className = 'pTop';
			const videoBox = document.createElement('div');
			videoBox.className = 'pVideo';

			// カメラや画面共有がある場合はサムネイル映像、なければアバター
			const pvStream = isScreen
				? realUid === Identity.id
					? App.screenStream
					: (
							App.screenMediaEls.get(realUid) || {
								srcObject: null,
							}
						).srcObject
				: realUid === Identity.id
					? App.localStream
					: (
							App.mediaEls.get(realUid) || {
								srcObject: null,
							}
						).srcObject;
			// 画面共有: ストリームが存在するだけで映像あり扱い。
			// readyState が一時的に 'live' 以外になっても黒画面にしない。
			const pvHasVideo = isScreen
				? (realUid === Identity.id
					? !!App.screenStream
					: !!(App.screenMediaEls.get(realUid)?.srcObject))
				: realUid === Identity.id
					? App.cameraOn
					: !!u.cameraOn;
			if (pvHasVideo) {
				const pv = document.createElement('video');
				pv.autoplay = true;
				pv.playsInline = true;
				// サムネイル表示用のvideo要素も同様に常にミュート
				pv.muted = true;
				pv.srcObject = pvStream;
				videoBox.appendChild(pv);
			} else {
				const av = document.createElement('div');
				av.className = 'avatar';
				applyAvatarEl(av, u);
				videoBox.appendChild(av);
			}

			top.appendChild(videoBox);

			const nameWrap = document.createElement('div');
			nameWrap.className = 'pName';
			let pNameStr = u.name || '名前なし';
			if (realUid === Identity.id && !isScreen) pNameStr = '*' + pNameStr;
			nameWrap.textContent = pNameStr;
			top.appendChild(nameWrap);

			const volumeWrap = document.createElement('div');
			volumeWrap.className = 'pVolume';
			const volIcon = document.createElement('span');
			volIcon.className = 'pVolIcon';
			volIcon.textContent = isScreen ? '画面' : '音量';
			const volInput = document.createElement('input');
			volInput.type = 'range';
			volInput.min = '0';
			volInput.max = '100';
			volInput.step = '1';
			volInput.value = String(
				Math.round(getMediaVolume(realUid, rowKind) * 100),
			);
			volInput.title = '音量';
			volInput.addEventListener('click', (e) => e.stopPropagation());
			volInput.addEventListener('input', (e) => {
				e.stopPropagation();
				setMediaVolume(realUid, rowKind, Number(volInput.value) / 100);
			});
			const volVal = document.createElement('span');
			volVal.className = 'pVolLabel';
			volVal.textContent = volInput.value + '%';
			volInput.addEventListener('input', () => {
				volVal.textContent = volInput.value + '%';
			});
			volumeWrap.appendChild(volIcon);
			volumeWrap.appendChild(volInput);
			volumeWrap.appendChild(volVal);
			row.appendChild(top);
			row.appendChild(volumeWrap);

			if (!isScreen && App.captionsOn) {
				const capEl = document.createElement('div');
				capEl.className = 'pCaption';
				// タイピングドットのtickだけで毎回 video 要素ごと再構築されるのを防ぐため、
				// 該当uidを識別子として付与し、_captionDotTick からは軽量な差分更新のみ行う
				capEl.dataset.captionUid = realUid;
				const { text, stale } = buildCaptionText(realUid);
				capEl.textContent = text;
				if (stale) capEl.style.opacity = '0.4';
				row.appendChild(capEl);
			}
			list.appendChild(row);
		});
	}

	/* ===================== rendering: log ===================== */

	let lastDayKey = null;
	const LOG_INITIAL_BATCH = 25; // 最低限読み込む件数
	const LOG_LOAD_MORE_BATCH = 25; // 自動追加読み込み時の件数
	let logChronCache = [];
	let logRenderedFrom = 0; // logChronCache中、現在描画済みの先頭インデックス
	let logLoadingMore = false;
	let logTopObserver = null;
	// 直前にレンダリングしたメッセージの送信者UID・タイムスタンプ（連続メッセージ判定用）
	let lastRenderedMsgUid = null;
	let lastRenderedMsgTs = 0;
	// 連続メッセージと見なす最大時間間隔（5分）
	const COMPACT_MSG_MAX_GAP_MS = 5 * 60 * 1000;

	function renderLog() {
		lastDayKey = null;
		lastRenderedMsgUid = null;
		lastRenderedMsgTs = 0;
		const log = document.getElementById('log');
		log.innerHTML = '';
		logChronCache = Array.from(App.messages.values())
			.filter((m) => m.k === 'chat' || m.k === 'file')
			.sort((a, b) => a.ts - b.ts);

		// 画面の高さ分くらいまでをひとまず描画し、残りは動的に読み込む
		const viewportH = log.clientHeight || window.innerHeight || 600;
		// 末尾から逆順に積算し、画面の高さを少し超えるまで件数を確保する
		const approxRowH = 56; // メッセージ1件あたりのおおよその高さ(px)
		const minByHeight = Math.ceil((viewportH + approxRowH) / approxRowH);
		const initialCount = Math.max(LOG_INITIAL_BATCH, minByHeight);
		logRenderedFrom = Math.max(0, logChronCache.length - initialCount);

		ensureLoadMoreSentinel();
		for (let i = logRenderedFrom; i < logChronCache.length; i++) {
			appendMessageEl(logChronCache[i]);
		}
		scrollLogToBottom();
	}

	// ログ先頭に監視用の見えないセンチネルを設置し、
	// 画面内に入ったタイミングで自動的に過去ログを読み込む
	function ensureLoadMoreSentinel() {
		const log = document.getElementById('log');
		let sentinel = document.getElementById('logTopSentinel');
		if (!sentinel) {
			sentinel = document.createElement('div');
			sentinel.id = 'logTopSentinel';
			sentinel.className = 'logTopSentinel';
		} else {
			sentinel.remove();
		}
		if (logRenderedFrom > 0) {
			log.insertBefore(sentinel, log.firstChild);
		}
		setupLogTopObserver(log, sentinel);
	}

	function setupLogTopObserver(log, sentinel) {
		if (logTopObserver) {
			logTopObserver.disconnect();
			logTopObserver = null;
		}
		if (logRenderedFrom <= 0) return;
		logTopObserver = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) loadMoreLog();
				}
			},
			{
				root: log,
				rootMargin: '200px 0px 0px 0px',
				threshold: 0,
			},
		);
		logTopObserver.observe(sentinel);
	}

	function loadMoreLog() {
		if (logLoadingMore || logRenderedFrom <= 0) return;
		logLoadingMore = true;
		const log = document.getElementById('log');
		const newFrom = Math.max(0, logRenderedFrom - LOG_LOAD_MORE_BATCH);
		logRenderedFrom = newFrom;

		// 現在のスクロール位置を保持するための基準
		const prevHeight = log.scrollHeight;
		const prevTop = log.scrollTop;

		lastDayKey = null;
		lastRenderedMsgUid = null;
		lastRenderedMsgTs = 0;
		log.innerHTML = '';
		ensureLoadMoreSentinel();
		const allVisible = logChronCache.slice(logRenderedFrom);
		for (const m of allVisible) appendMessageEl(m);

		const newHeight = log.scrollHeight;
		log.scrollTop = prevTop + (newHeight - prevHeight);
		logLoadingMore = false;
	}
	function maybeDaySeparator(ts) {
		const dk = dayKey(ts);
		if (dk !== lastDayKey) {
			lastDayKey = dk;
			const sep = document.createElement('div');
			sep.className = 'daySep';
			sep.textContent = new Date(ts).toLocaleDateString('ja-JP', {
				year: 'numeric',
				month: 'long',
				day: 'numeric',
			});
			document.getElementById('log').appendChild(sep);
		}
	}
	function appendSystemEl(m) {
		const log = document.getElementById('log');
		const div = document.createElement('div');
		div.className = 'msg system';
		const body = document.createElement('div');
		body.className = 'body';
		body.textContent = m.text;
		div.appendChild(body);
		log.appendChild(div);
	}
	// ===================== NyaXEmoji =====================
	const NyaXEmoji = (() => {
		const LIST_URL = './emoji/list.json';
		let idSet = null;
		// fetch済みのidからビルドした正規表現（長いidを先にマッチさせる）
		let emojiRe = null;
		let fetchPromise = null;

		function escapeRe(s) {
			return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		}

		function init() {
			if (fetchPromise) return fetchPromise;
			fetchPromise = fetch(LIST_URL)
				.then((r) => {
					if (!r.ok) throw new Error('emoji list fetch failed');
					return r.json();
				})
				.then((list) => {
					if (!Array.isArray(list)) return;
					const s = new Set();
					for (const entry of list) {
						// idが文字列かつ安全な文字（英数字・アンダースコア・ハイフン）のみ受け入れる
						if (
							entry &&
							typeof entry.id === 'string' &&
							/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(entry.id)
						) {
							s.add(entry.id);
						}
					}
					idSet = s;
					// idを長い順に並べてORパターンを構築（長いidを優先マッチ）
					if (s.size > 0) {
						const sorted = Array.from(s).sort(
							(a, b) => b.length - a.length,
						);
						emojiRe = new RegExp(
							'_(' + sorted.map(escapeRe).join('|') + ')_',
							'g',
						);
					}
					// 登録済みコールバックを呼び出す
					for (const cb of readyCallbacks) {
						try {
							cb();
						} catch (_) {}
					}
					readyCallbacks = [];
				})
				.catch(() => {
					idSet = new Set();
					emojiRe = null;
				});
			return fetchPromise;
		}

		// fetch完了後に一度だけ呼ばれるコールバックを登録する
		let readyCallbacks = [];
		function onReady(cb) {
			if (idSet !== null) {
				// 既にfetch済みなら即実行
				try {
					cb();
				} catch (_) {}
			} else {
				readyCallbacks.push(cb);
			}
		}

		// 現在有効な正規表現（fetch前またはid数0はnull）
		function getRegExp() {
			return emojiRe;
		}

		// idが既知の絵文字かどうかを返す
		function has(id) {
			return idSet !== null && idSet.has(id);
		}

		// 絵文字imgのURLを生成
		function imgUrl(id) {
			return './emoji/' + encodeURIComponent(id) + '.svg';
		}

		return { init, getRegExp, has, imgUrl, onReady };
	})();

	// emoji一覧のfetch完了後に既存メッセージのbodyを再描画する
	function rerenderExistingEmoji() {
		const log = document.getElementById('log');
		if (!log) return;
		// id → message のマップをキャッシュから構築
		const msgMap = new Map();
		for (const m of logChronCache) {
			if (m.id && m.text && !m.deleted && m.k !== 'file') {
				msgMap.set(m.id, m);
			}
		}
		// #log 内の各メッセージ要素を走査して body を再描画
		log.querySelectorAll('.msg[id^="m_"]:not(.deleted)').forEach((el) => {
			const msgId = el.id.slice(2); // "m_" を除去
			const m = msgMap.get(msgId);
			if (!m) return;
			const body = el.querySelector('.body');
			if (!body) return;
			// body を再描画（既存ノードをクリアして再構築）
			body.innerHTML = '';
			renderTextWithLinks(body, m.text);
		});
	}

	// テキスト内のURLをaタグに変換してcontainerに安全に追加（XSS対策済み）
	// _emojiId_ パターンをNyaXEmojiに置き換える機能も内包
	function renderTextWithLinks(container, text) {
		if (!text) {
			container.textContent = '';
			return;
		}

		// fetch済みidから構築した正規表現を取得（未完了時はnull）
		const emojiRe = NyaXEmoji.getRegExp();
		if (!emojiRe) {
			// emoji一覧未取得の場合はURL linkifyのみ実施
			_appendTextWithLinks(container, text);
			return;
		}

		// _id_ パターンをemojiに置き換えながらテキストを走査
		// 正規表現はfetch済みidのORパターン（長いidを優先）なので誤マッチしない
		emojiRe.lastIndex = 0;
		let lastIndex = 0;
		let match;

		while ((match = emojiRe.exec(text)) !== null) {
			const before = text.slice(lastIndex, match.index);
			if (before) _appendTextWithLinks(container, before);

			const emojiId = match[1]; // サーバーから取得したidのみマッチするので安全
			const img = document.createElement('img');
			img.src = NyaXEmoji.imgUrl(emojiId);
			img.alt = '_' + emojiId + '_';
			img.title = '_' + emojiId + '_';
			img.className = 'nyaxEmoji';
			container.appendChild(img);

			lastIndex = match.index + match[0].length;
		}

		if (lastIndex < text.length) {
			_appendTextWithLinks(container, text.slice(lastIndex));
		}
	}

	// URL linkify のみ行う内部ヘルパー（emojiトークン展開済みのセグメントに使用）
	function _appendTextWithLinks(container, text) {
		if (!text) return;
		// httpsおよびhttpのURLのみ検出（安全スキームに限定）
		const URL_RE =
			/https?:\/\/[^\s<>"'`\u3000-\u303f\uff00-\uffef\u2019\u201d]+/g;
		let lastIndex = 0;
		let match;
		URL_RE.lastIndex = 0;
		while ((match = URL_RE.exec(text)) !== null) {
			const before = text.slice(lastIndex, match.index);
			if (before) container.appendChild(document.createTextNode(before));
			// URL末尾の句読点・カッコ等を除去
			let url = match[0].replace(
				/[.,!?;:)\]}>「」。、！？：；'"`]+$/,
				'',
			);
			try {
				const parsed = new URL(url);
				// http/httpsのみ許可（javascript:など危険なスキームを排除）
				if (
					parsed.protocol === 'https:' ||
					parsed.protocol === 'http:'
				) {
					const a = document.createElement('a');
					a.className = 'chatLink';
					a.href = url;
					a.target = '_blank';
					a.rel = 'noopener noreferrer';
					a.textContent = url;
					container.appendChild(a);
					// URL末尾の除去分をテキストノードとして追加
					const suffix = match[0].slice(url.length);
					if (suffix)
						container.appendChild(document.createTextNode(suffix));
				} else {
					container.appendChild(document.createTextNode(match[0]));
				}
			} catch (e) {
				container.appendChild(document.createTextNode(match[0]));
			}
			lastIndex = match.index + match[0].length;
		}
		if (lastIndex < text.length) {
			container.appendChild(
				document.createTextNode(text.slice(lastIndex)),
			);
		}
	}

	// テキスト本文が5行を超える場合に折りたたみ処理を適用する
	// bodyがDOMに追加される前に呼ばれる場合（高さ測定不可）は改行数で判定し、
	// DOMマウント後にResizeObserverで再確認して過剰な折りたたみを解除する。
	function applyBodyCollapse(body) {
		const LINE_HEIGHT_EM = 1.55;
		const MAX_LINES = 5;

		// 改行カウントによる事前判定（DOM追加前でも動作）
		const text = body.textContent || '';
		const newlineCount = (text.match(/\n/g) || []).length;
		// 改行が4以下なら折りたたみ不要（5行以内確定）
		if (newlineCount < MAX_LINES) return;

		// 改行が多い場合は折りたたみを適用し、DOM挿入後に高さで再確認
		body.classList.add('collapsed');

		// DOM挿入後に実際の行数を測定して判定を補正する
		// requestAnimationFrameでレイアウト確定後に実行
		const fontSize = 13.5; // px (font-size: 13.5px)
		requestAnimationFrame(() => {
			const lineHeightPx =
				parseFloat(getComputedStyle(body).lineHeight) ||
				fontSize * LINE_HEIGHT_EM;
			const maxHeightPx = lineHeightPx * MAX_LINES;
			// scrollHeightが閾値以下なら折りたたみ不要として元に戻す
			if (body.scrollHeight <= Math.ceil(maxHeightPx) + 1) {
				body.classList.remove('collapsed');
				const parent2 = body.parentElement;
				const afterEl2 =
					parent2 && parent2.classList.contains('compactBodyRow')
						? parent2.nextElementSibling
						: body.nextElementSibling;
				if (afterEl2 && afterEl2.classList.contains('showMoreBtn'))
					afterEl2.remove();
				return;
			}
			// 「続きを表示」ボタンがまだなければ挿入
			// body が compactBodyRow 内にある場合は親の次の要素を確認
			const parent = body.parentElement;
			const afterEl =
				parent && parent.classList.contains('compactBodyRow')
					? parent.nextElementSibling
					: body.nextElementSibling;
			if (!afterEl || !afterEl.classList.contains('showMoreBtn')) {
				insertShowMoreBtn(body);
			}
		});
	}

	function insertShowMoreBtn(body) {
		const btn = document.createElement('button');
		btn.className = 'showMoreBtn';
		btn.textContent = '続きを表示';
		btn.onclick = () => {
			const collapsed = body.classList.toggle('collapsed');
			btn.textContent = collapsed ? '続きを表示' : '折りたたむ';
		};
		// body が compactBodyRow 内に移動済みの場合はその外側に挿入
		const parent = body.parentElement;
		if (parent && parent.classList.contains('compactBodyRow')) {
			parent.insertAdjacentElement('afterend', btn);
		} else {
			body.insertAdjacentElement('afterend', btn);
		}
	}

	function appendMessageEl(m) {
		// 新規メッセージなら、動的読み込み用キャッシュにも追従させる
		if (
			logChronCache.length &&
			!logChronCache.some((x) => x.id === m.id) &&
			m.ts >= logChronCache[logChronCache.length - 1].ts
		) {
			logChronCache.push(m);
		}
		const log = document.getElementById('log');

		// 直前のメッセージと同じユーザーかつ5分以内かつ日付が変わっていない場合に連続メッセージと見なす
		// 返信メッセージ・削除済みは常にヘッダーを表示
		const prevDayKey = lastDayKey;
		maybeDaySeparator(m.ts);
		const dayChanged = prevDayKey !== lastDayKey;
		const isCompactMsg =
			!m.deleted &&
			!m.replyTo &&
			m.uid &&
			m.uid === lastRenderedMsgUid &&
			m.ts - lastRenderedMsgTs < COMPACT_MSG_MAX_GAP_MS &&
			!dayChanged;
		// レンダリング後に追跡変数を更新
		lastRenderedMsgUid = m.uid || null;
		lastRenderedMsgTs = m.ts || 0;

		// msgコンテナ (左側にアバターを配置するフレックスレイアウト)
		const div = document.createElement('div');
		div.className =
			'msg' +
			(m.deleted ? ' deleted' : '') +
			(isCompactMsg ? ' compact' : '');
		div.id = 'm_' + m.id;

		// 左側: アバター
		const av = document.createElement('div');
		av.className = 'avatar msgAvatar';
		// ユーザー情報を取得
		// 優先順位: デバイス上の永続ユーザーリストデータ (UserStore) > ルーム内現在のユーザー (App.users) > ルーム履歴 (allMembers) > メッセージフォールバック
		// これにより、相手のユーザー情報変更時に自動更新されたデバイスデータから表示する
		const isSelf = m.uid === Identity.id;
		let senderUser;
		if (isSelf) {
			senderUser = {
				name: Profile.name,
				image: Profile.image,
				uid: Identity.id,
			};
		} else {
			const deviceUser = UserStore.get(m.uid);
			const liveUser = App.users.get(m.uid);
			const memberUser = App.allMembers.get(m.uid);
			senderUser = deviceUser ||
				liveUser ||
				memberUser || {
					uid: m.uid,
					name: m.name || '名前なし',
					image: null,
				};
		}
		applyAvatarEl(av, senderUser);
		av.style.cursor = 'pointer';
		av.onclick = (e) => {
			e.stopPropagation();
			openUserModal && openUserModal(m.uid);
		};
		div.appendChild(av);

		// 右側: コンテンツ
		const content = document.createElement('div');
		content.className = 'msgContent';

		const meta = document.createElement('div');
		meta.className = 'meta';
		const nameSpan = document.createElement('span');
		nameSpan.className = 'name';
		nameSpan.style.cursor = 'pointer';
		nameSpan.textContent = getDisplayName(senderUser) || '名前なし';
		nameSpan.onclick = (e) => {
			e.stopPropagation();
			openUserModal && openUserModal(m.uid);
		};
		meta.appendChild(nameSpan);
		meta.appendChild(document.createTextNode('  ·  ' + fmtTime(m.ts)));
		const idSpan = document.createElement('span');
		idSpan.className = 'msgUid';
		idSpan.textContent = '  ·  #' + (m.uid || '').slice(0, 10);
		idSpan.title = m.uid || '';
		meta.appendChild(idSpan);
		content.appendChild(meta);

		// 返信元の引用表示
		if (m.replyTo && m.replyTo.id) {
			const rq = document.createElement('div');
			rq.className = 'replyQuote';
			const rqName = document.createElement('span');
			rqName.className = 'replyName';
			rqName.textContent = m.replyTo.name || '名前なし';
			const rqText = document.createElement('span');
			rqText.className = 'replyText';
			rqText.textContent = m.replyTo.text || '（メッセージ）';
			rq.appendChild(rqName);
			rq.appendChild(rqText);
			rq.onclick = () => jumpToMessage(m.replyTo.id);
			content.appendChild(rq);
		}

		const body = document.createElement('div');
		body.className = 'body';
		if (m.deleted) {
			body.textContent = 'メッセージは削除されました';
			content.appendChild(body);
		} else if (m.k === 'file') {
			renderFileBody(body, m);
			content.appendChild(body);
		} else {
			renderTextWithLinks(body, m.text);
			// 5行超えの場合は折りたたむ
			applyBodyCollapse(body);
			content.appendChild(body);
		}

		// 返信ボタン：削除されていないメッセージに表示
		if (!m.deleted) {
			const replyBtn = document.createElement('button');
			replyBtn.className = 'replyBtn';
			replyBtn.textContent = '返信';
			replyBtn.onclick = () => startReply(m);
			meta.appendChild(replyBtn);
		}

		// 削除ボタン：送信者本人のメッセージにのみ表示（テキスト・ファイル両方）
		if (!m.deleted && m.uid === Identity.id) {
			const del = document.createElement('button');
			del.className = 'delBtn';
			del.textContent = '削除';
			del.onclick = async () => {
				if (!await showConfirm('このメッセージを削除しますか？')) return;
				sendDeleteFor(m.id);
			};
			meta.appendChild(del);
		}

		// コンパクット時: ボタンをメッセージ本文の真右に配置する専用コンテナ
		if (isCompactMsg && !m.deleted) {
			const actions = document.createElement('div');
			actions.className = 'compactActions';
			// meta内のボタンをこちらに移動
			content.querySelectorAll('.replyBtn, .delBtn').forEach((btn) => {
				actions.appendChild(btn);
			});
			// bodyとactionsを横並びにするラッパー
			const bodyRow = document.createElement('div');
			bodyRow.className = 'compactBodyRow';
			const existingBody = content.querySelector('.body');
			content.insertBefore(bodyRow, existingBody);
			bodyRow.appendChild(existingBody);
			bodyRow.appendChild(actions);
		}

		// ダブルクリックでも返信開始
		if (!m.deleted) {
			div.ondblclick = () => startReply(m);
		}

		div.appendChild(content);
		log.appendChild(div);
	}
	function markElDeleted(el) {
		el.classList.add('deleted');
		el.classList.remove('compact'); // 削除済みは名前・アバターを表示する
		const body = el.querySelector('.body');
		if (body) body.textContent = 'メッセージは削除されました';
		const del = el.querySelector('.delBtn');
		if (del) del.remove();
	}
	function renderFileBody(body, m) {
		const f = m.file;
		if (!f) {
			body.textContent = 'ファイル';
			return;
		}
		const state = f.fileId ? App.fileTransfers.get(f.fileId) : null;
		if (f.fileId && !f.objectUrl) hydrateFilePreview(f, true);
		const isReady = !!(
			state?.status === 'complete' ||
			state?.status === 'ready' ||
			f.objectUrl
		);
		let previewUrl = f.objectUrl;
		if (!previewUrl && f.fileId) {
			const rec = App.fileTransfers.get(f.fileId);
			if (rec?.objectUrl) previewUrl = rec.objectUrl;
		}
		const previewable = canPreviewFile(f) && isReady;
		// 未受信ファイルはプレビューを表示しない（転送リクエストを促す）
		if (isReady && previewUrl) {
			if (f.mime && f.mime.startsWith('image/')) {
				const img = document.createElement('img');
				img.className = 'preview';
				img.src = previewUrl;
				img.alt = f.name;
				img.addEventListener('click', (e) => {
					e.stopPropagation();
					openFilePreview(m);
				});
				body.appendChild(img);
			} else if (f.mime && f.mime.startsWith('video/')) {
				const video = document.createElement('video');
				video.className = 'preview previewVideo';
				video.src = previewUrl;
				video.controls = true;
				video.playsInline = true;
				video.preload = 'metadata';
				body.appendChild(video);
			} else if (f.mime && f.mime.startsWith('audio/')) {
				const audio = document.createElement('audio');
				audio.className = 'previewAudio';
				audio.src = previewUrl;
				audio.controls = true;
				body.appendChild(audio);
			}
		}
		// 受信済みで画像/動画/音声はメディア要素のみ表示（ファイルカードは出さない）
		const showFileCard = !(
			isReady &&
			previewUrl &&
			f.mime &&
			/^(image|video|audio)\//.test(f.mime)
		);
		if (!showFileCard) {
			// 画像プレビューのみで十分な場合はここで終了（クリーン表示）
			return;
		}
		const wrap = document.createElement('div');
		wrap.className = 'file' + (previewable ? ' filePreviewable' : '');
		if (previewable) {
			wrap.title = 'クリックでプレビュー';
			wrap.addEventListener('click', (e) => {
				e.stopPropagation();
				openFilePreview(m);
			});
		}
		const label = document.createElement('span');
		label.textContent = `${f.name} ${bytesToSize(f.size)}`;
		wrap.appendChild(label);

		let downloadUrl = previewUrl;
		if (!downloadUrl && f.fileId && state?.objectUrl)
			downloadUrl = state.objectUrl;
		if (downloadUrl || isReady) {
			const a = document.createElement('a');
			a.href = downloadUrl || '#';
			a.download = safeFileName(f.name); // Issue 3
			a.textContent = 'ダウンロード';
			a.addEventListener('click', (e) => e.stopPropagation());
			if (!downloadUrl) {
				a.onclick = async (e) => {
					e.preventDefault();
					e.stopPropagation();
					const rec = await getFileRecord(f.fileId);
					if (!rec?.blob) return;
					const url = URL.createObjectURL(rec.blob);
					const aa = document.createElement('a');
					aa.href = url;
					aa.download = safeFileName(f.name); // Issue 3
					aa.click();
					// メモリリーク防止: 次のマイクロタスク後に解放
					setTimeout(() => URL.revokeObjectURL(url), 0);
				};
			}
			wrap.appendChild(a);
		} else {
			const note = document.createElement('span');
			note.style.color = 'var(--sub)';
			note.textContent = '保存されていません';
			wrap.appendChild(note);
		}
		if (previewable) {
			const hint = document.createElement('span');
			hint.className = 'filePreviewHint';
			hint.textContent = 'クリックで拡大';
			wrap.appendChild(hint);
		}
		body.appendChild(wrap);
		// 真の進行中（receiving/sending/offered）のみ下に進捗UIを追加
		// requesting / waiting / missing はカード内にボタンを統合して安定表示
		const activeTransferStates = ['receiving', 'sending', 'offered'];
		const transferStatus = state ? state.status : null;
		if (
			state &&
			activeTransferStates.includes(String(transferStatus || ''))
		) {
			renderFileTransferBox(body, m, f, state);
		} else if (f.fileId && !isReady) {
			// 未受信カード（常に統合）
			// 注意: 描画関数は読み取り専用にすること。
			// 以前はここで state.status を 'missing' に強制上書きしており、
			// 'requesting'/'waiting' の間に他要因（新規メッセージ等）で
			// renderLog() が再実行されるたびに転送状態が壊れ、
			// リクエストを送っても転送が開始されない原因になっていた。
			const state2 = currentFileState(f.fileId);
			const displayStatus = ['requesting', 'waiting'].includes(
				state2.status,
			)
				? state2.status
				: 'missing';

			const reqBtn = document.createElement('button');
			if (displayStatus === 'requesting' || displayStatus === 'waiting') {
				reqBtn.textContent = 'リクエスト中...';
				reqBtn.disabled = true;
			} else {
				reqBtn.textContent = '転送をリクエスト';
				reqBtn.onclick = () => {
					requestFileRelay(f, m);
					reqBtn.textContent = 'リクエスト中...';
					reqBtn.disabled = true;
					const st = currentFileState(f.fileId);
					st.status = 'requesting';
				};
			}
			wrap.appendChild(reqBtn);
		}
	}
	// ファイル転送の進捗だけを軽量に更新する（ログ全体の再描画を避ける）
	function updateFileMessageEl(fileId) {
		const msg = findMessageByFileId(fileId);
		if (!msg) return false;
		const div = document.getElementById('m_' + msg.id);
		if (!div) return false;
		const body = div.querySelector('.body');
		if (!body) return false;
		body.innerHTML = '';
		renderFileBody(body, msg);
		return true;
	}
	function scrollLogToBottom() {
		const log = document.getElementById('log');
		log.scrollTop = log.scrollHeight;
	}

	/* ===================== reply (返信) ===================== */

	let pendingReply = null; // { id, uid, name, text }
	let pendingReopenSocial = false;

	function snippetText(m) {
		if (!m) return '';
		if (m.deleted) return 'メッセージは削除されました';
		if (m.k === 'file') return 'ファイル: ' + (m.file?.name || '');
		const t = (m.text || '').replace(/\s+/g, ' ').trim();
		return t.length > 60 ? t.slice(0, 60) + '…' : t;
	}

	function replyAuthorName(m) {
		if (!m) return '';
		const isSelf = m.uid === Identity.id;
		if (isSelf) return Profile.name;
		const u = App.users.get(m.uid);
		return (u && u.name) || m.name || '名前なし';
	}

	function startReply(m) {
		if (!m || m.deleted) return;
		pendingReply = {
			id: m.id,
			uid: m.uid,
			name: replyAuthorName(m),
			text: snippetText(m),
		};
		const bar = document.getElementById('replyPreviewBar');
		document.getElementById('replyBarName').textContent = pendingReply.name;
		document.getElementById('replyBarText').textContent = pendingReply.text;
		bar.classList.add('active');
		const ta = document.getElementById('msgInput');
		if (ta) ta.focus();
	}

	function cancelReply() {
		pendingReply = null;
		document.getElementById('replyPreviewBar').classList.remove('active');
	}

	function jumpToMessage(id) {
		const el = document.getElementById('m_' + id);
		if (!el) {
			toast('元のメッセージが見つかりません');
			return;
		}
		el.scrollIntoView({ behavior: 'smooth', block: 'center' });
		el.classList.remove('highlightFlash');
		void el.offsetWidth;
		el.classList.add('highlightFlash');
	}

	/* ===================== typing indicator ===================== */

	const TypingState = (() => {
		// uid -> expiry timer id
		const _timers = new Map();
		// uid -> name (snapshot at receive time)
		const _active = new Map();
		const EXPIRE_MS = 6000; // 入力中状態の有効期間
		const SEND_INTERVAL_MS = 3000; // 定期送信間隔

		let _sendTimer = null;
		let _isSending = false;
		let _lastSentAt = 0;

		function _nameFor(uid) {
			const u = App.users.get(uid);
			return (u && u.name) || '名前なし';
		}

		function _render() {
			const el = document.getElementById('typingIndicator');
			if (!el) return;
			const uids = Array.from(_active.keys());
			if (!uids.length) {
				el.textContent = '';
				return;
			}
			const names = uids.map(_nameFor);
			let label;
			if (names.length === 1) {
				label = names[0] + ' が入力中';
			} else if (names.length === 2) {
				label = names[0] + '、' + names[1] + ' が入力中';
			} else {
				label =
					names[0] +
					'、' +
					names[1] +
					' 他 ' +
					(names.length - 2) +
					' 人が入力中';
			}
			el.innerHTML =
				'<span class="typingDots"><span></span><span></span><span></span></span>' +
				'<span class="typingText"></span>';
			el.querySelector('.typingText').textContent = label;
		}

		function receive(fromUid, active) {
			if (_timers.has(fromUid)) {
				clearTimeout(_timers.get(fromUid));
				_timers.delete(fromUid);
			}
			if (active) {
				_active.set(fromUid, true);
				const t = setTimeout(() => {
					_active.delete(fromUid);
					_timers.delete(fromUid);
					_render();
				}, EXPIRE_MS);
				_timers.set(fromUid, t);
			} else {
				_active.delete(fromUid);
			}
			_render();
		}

		async function _sendTyping(active) {
			if (!App.connected || !App.roomId) return;
			const ts = Date.now();
			const signable = {
				k: 'typing',
				uid: Identity.id,
				roomId: App.roomId,
				ts,
				active,
			};
			const sig = await signPayload(signable);
			distribute({
				k: 'typing',
				uid: Identity.id,
				roomId: App.roomId,
				ts,
				active,
				pub: Identity.pubJwk,
				sig,
			});
		}

		function startTyping() {
			// 毎回即座に送信（スロットル: 最低1秒間隔）
			const now = Date.now();
			if (!_isSending || now - (_lastSentAt || 0) >= 1000) {
				_isSending = true;
				_lastSentAt = now;
				_sendTyping(true);
			}
			// タイムアウト延長用の定期送信タイマーをリセット
			if (_sendTimer) clearTimeout(_sendTimer);
			_sendTimer = setTimeout(() => {
				if (_isSending) {
					_lastSentAt = Date.now();
					_sendTyping(true);
					// 入力が続いていればさらに延長するタイマーをセット
					_sendTimer = setTimeout(function repeat() {
						if (_isSending) {
							_lastSentAt = Date.now();
							_sendTyping(true);
							_sendTimer = setTimeout(repeat, SEND_INTERVAL_MS);
						}
					}, SEND_INTERVAL_MS);
				}
			}, SEND_INTERVAL_MS);
		}

		function stopTyping() {
			if (!_isSending) return;
			_isSending = false;
			if (_sendTimer) {
				clearTimeout(_sendTimer);
				_sendTimer = null;
			}
			_sendTyping(false);
		}

		function clearAll() {
			_timers.forEach((t) => clearTimeout(t));
			_timers.clear();
			_active.clear();
			_render();
		}

		return { receive, startTyping, stopTyping, clearAll };
	})();

	/* ===================== sending ===================== */

	function sendTextMessage() {
		const ta = document.getElementById('msgInput');
		const text = ta.value.trim();
		if (!text || !App.connected) return;
		TypingState.stopTyping();
		App._captionTyping.delete(Identity.id);
		sendAppMessage({
			k: 'chat',
			id: uid(),
			text,
			ts: Date.now(),
			replyTo: pendingReply,
		});
		ta.value = '';
		ta.style.height = 'auto';
		cancelReply();
	}
	async function sendFile(file) {
		if (!App.connected) return;
		// 20MB制限撤廃
		const buf = await file.arrayBuffer();
		const fileId = makeFileId();
		const hash = await digestHex(buf);
		const record = {
			fileId,
			roomId: App.roomId,
			ownerUid: Identity.id,
			name: file.name,
			mime: file.type || 'application/octet-stream',
			size: file.size,
			hash,
			blob: new Blob([buf], {
				type: file.type || 'application/octet-stream',
			}),
			updatedAt: new Date().toISOString(),
		};
		await putFileRecord(record);
		const payload = await sendAppMessage({
			k: 'file',
			id: uid(),
			ts: Date.now(),
			file: {
				fileId,
				name: file.name,
				mime: file.type || 'application/octet-stream',
				size: file.size,
				hash,
				chunkSize: FILE_CHUNK_SIZE,
				senderUid: Identity.id,
				createdAt: Date.now(),
				transferStatus: 'offered',
			},
		});
		const state = currentFileState(fileId);
		state.status = 'sending';
		state.totalBytes = file.size;
		state.sentBytes = 0;
		state.currentSenderUid = Identity.id;
		state.file = cloneFileMeta(payload.file);
		state.file.senderUid = Identity.id;
		App.fileTransfers.set(state.key || fileId, state);
		if (!updateFileMessageEl(fileId)) renderLog();
		// ファイル送信トーストは廃止

		// 受信側からの accept 待ちにせず、現在ルームにいる全ピアへ即座にプッシュ送信する
		const peerUids = Array.from(App.users.values())
			.map((u) => u.uid)
			.filter((u) => u && u !== Identity.id);
		await Promise.all(
			peerUids.map((targetUid) =>
				startSendingFileToUid(payload.file, targetUid, 'push'),
			),
		);
		if (!peerUids.length) {
			state.status = 'complete';
			App.fileTransfers.set(state.key || fileId, state);
			if (!updateFileMessageEl(fileId)) renderLog();
		}
	}

	/* ===================== social panel ===================== */

	/* ===================== room open / create / join / leave ===================== */

	function openRoom(roomId, name, persist, requireHost) {
		if (!Profile.name) {
			console.log('Opening room postponed: initial setup not completed.');
			return;
		}
		console.log('Opening room: ', roomId, {
			name,
			persist,
			requireHost,
		});
		if (App.roomId === roomId && App.connected) {
			if (isMobile || isCompactPC()) setSidebarOpen(false);
			return;
		}
		if (App.roomId && App.roomId !== roomId) resetConnectionState(/* keepUsers */ false, /* skipVoiceRestore */ true);

		App.roomId = roomId;
		App.requireExistingHost = !!requireHost;
		App.roomMembers = new Set();
		App.allMembers = new Map();
		App.roomOption = {
			name: name || '無題のスペース',
			persist: !!persist,
			updatedAt: 0,
		};
		// 旧ルームの非同期接続処理が新ルームに割り込まないよう、
		// ルーム切り替え時点でセッションを進める
		nextConnectSession();
		// ルームの全参加者リストをデバイスから復元（persistルームのみ）
		if (persist && roomId) {
			const savedMembers = RoomStore.loadMembers(roomId);
			for (const u of savedMembers) {
				if (u && u.uid) {
					App.allMembers.set(u.uid, u);
					UserStore.upsert(u);
				}
			}
		}
		App.messages = new Map();
		App.fileIdIndex = new Map();
		App.fileTransfers.forEach((state) => {
			if (state && state.requestTimer) clearTimeout(state.requestTimer);
		});
		App.fileTransfers = new Map();
		App.transferStats = new Map();

		if (isMobile || isCompactPC()) {
			setSidebarOpen(false);
		}

		if (persist) {
			RoomStore.loadMessages(roomId).forEach((m) => {
				if (m.uid && App.mutedUsers.has(m.uid)) return;
				// dataB64 廃止済み
				if (m.file && m.file.fileId) {
					m.file = normalizeFileMeta(m.file);
					hydrateFilePreview(m.file, false);
				}
				App.messages.set(m.id, m);
				indexMessage(m);
			});
		}

		document.getElementById('emptyState').style.display = 'none';
		document.getElementById('roomView').style.display = 'flex';
		document.getElementById('userPopover').style.display = 'none';
		renderHeader();
		renderLog();
		renderUserPopover();
		renderRoomList();
		renderVoiceScreen();

		// popstateによる再入を防ぐためreplaceStateでクエリパラメータを更新する
		const _newSearch = buildModeSearch(roomId);
		if (location.search !== _newSearch) {
			history.replaceState(history.state, '', _newSearch);
		}

		connectFlow();
	}

	function createRoom(name, persist) {
		const roomId = randomRoomId();
		const meta = {
			id: roomId,
			name: name || '無題のスペース',
			persist,
			lastVisited: Date.now(),
		};
		if (persist) RoomStore.upsert(meta);
		else App.ephemeral = meta;
		renderRoomList();
		console.log('Created room: ', roomId, { name, persist });
		openRoom(roomId, meta.name, persist);
		// 接続確立後にルームオプションを配布（最大10秒でタイムアウト）
		const deadline = Date.now() + 10000;
		const iv = setInterval(() => {
			if (App.connected) {
				clearInterval(iv);
				updateRoomOption({ name: meta.name, persist });
			} else if (Date.now() > deadline) {
				clearInterval(iv);
			}
		}, 150);
	}

	function leaveCurrentRoom() {
		if (isMobile) {
			setSidebarOpen(true);
		}
		TypingState.stopTyping();
		TypingState.clearAll();
		const leavingRoomId = App.roomId;
		// 意図的な退出なので keepUsers=false で完全リセット
		// _wasInVoice もクリアして不意の復帰を防ぐ
		App._wasInVoice = false;
		App._reconnectAttempt = 0;
		resetConnectionState(/* keepUsers */ false);
		// 退出時はそのルームのファイル実体をすべて削除
		if (leavingRoomId) {
			cleanupRoomFiles(leavingRoomId).catch(() => {});
		}
		// Issue 10: 蓄積した objectURL をまとめて解放してメモリリークを防ぐ
		App._objectUrls.forEach((url) => {
			try {
				URL.revokeObjectURL(url);
			} catch (e) {}
		});
		App._objectUrls.clear();
		document.getElementById('roomView').style.display = 'none';
		document.getElementById('emptyState').style.display = 'flex';
		App.roomId = null;
		App.requireExistingHost = false;
		App.reconnecting = false;
		App.ephemeral = null;
		App.roomMembers = new Set();
		const _lSearch = buildModeSearch(null);
		if (location.search !== _lSearch) {
			history.replaceState(null, '', location.pathname + _lSearch);
		}
		renderRoomList();
	}

	/* ===================== fallback check ===================== */
	function verifyAndFallback(roomId) {
		// 招待リンクなどで参加する際、一覧にない新規ルームIDが弾かれないように正規表現検証に変更
		const isValidId = /^[A-Za-z0-9\-]{4,30}$/.test(roomId);
		if (!isValidId) {
			toast('無効なスペースIDです。ホームに戻りました');
			leaveCurrentRoom();
			return false;
		}
		// 実際の接続検証（ホスト存在確認など）はopenRoom内で行われる
		return true;
	}

	/* ===================== modals ===================== */

	const backStack = [];
	let isInternalBack = false;

	// バックスタック管理
	function openOverlay(id, { noHistory = false } = {}) {
		document.getElementById(id).classList.add('show');
		if (!noHistory) {
			backStack.push({ type: 'modal', id });
			history.pushState({ nk: 'modal', id }, '');
		}
	}
	function closeOverlay(
		id,
		{ fromHistory = false, noHistoryBack = false } = {},
	) {
		const el = document.getElementById(id);
		if (!el || !el.classList.contains('show')) return;
		el.classList.remove('show');
		if (id === 'ovFilePreview') {
			if (App.currentFilePreviewUrl) {
				try {
					URL.revokeObjectURL(App.currentFilePreviewUrl);
				} catch (e) {}
				App.currentFilePreviewUrl = null;
			}
			const stage = document.getElementById('filePreviewStage');
			if (stage) stage.innerHTML = '';
		}
		if (!fromHistory && !noHistoryBack) {
			const idx = backStack.findIndex((item) => item.type === 'modal' && item.id === id);
			if (idx !== -1) {
				backStack.splice(idx, 1);
				isInternalBack = true;
				history.back();
			}
		}
	}

	function closeSidebarIfMobile() {
		if (isMobile) setSidebarOpen(false);
	}

	function openCreateModal() {
		closeSidebarIfMobile();
		document.getElementById('crName').value = '';
		document.getElementById('crPersist').checked = false;
		showCreateTab('create');
		openOverlay('ovCreate');
	}
	function showCreateTab(which) {
		document
			.getElementById('tabCreate')
			.classList.toggle('active', which === 'create');
		document
			.getElementById('tabJoin')
			.classList.toggle('active', which === 'join');
		document.getElementById('paneCreate').style.display =
			which === 'create' ? 'block' : 'none';
		document.getElementById('paneJoin').style.display =
			which === 'join' ? 'block' : 'none';
		document.getElementById('jnErr').textContent = '';
	}
	function openRoomSettings() {
		if (!App.roomId) return;
		document.getElementById('rsName').value = App.roomOption.name || '';
		document.getElementById('rsPersist').checked = !App.roomOption.persist;

		const _rParts = ['r=' + encodeURIComponent(App.roomId)];
		// 一時チャット、または現在のクエリにsimpleが指定されている場合は simple を付与
		if (!App.roomOption.persist || isSimpleMode()) {
			_rParts.push('simple');
		}
		// ボイスチャット接続中は voice を付与
		if (App.localStream) {
			_rParts.push('voice');
		}
		const link =
			location.origin + location.pathname + '?' + _rParts.join('&');
		document.getElementById('rsLink').value = link;
		openOverlay('ovRoomSettings');
	}
	function openProfileModal({ firstSetup = false } = {}) {
		closeSidebarIfMobile();
		const overlay = document.getElementById('ovProfile');
		document.getElementById('pfName').value = Profile.name;
		applyAvatarEl(document.getElementById('pfAvatarPreview'), Profile);
		if (firstSetup) {
			overlay.classList.add('firstSetup');
			document.getElementById('pfTitle').textContent = 'ようこそ!';
			document.getElementById('pfSubtitle').style.display = 'block';
		} else {
			overlay.classList.remove('firstSetup');
			document.getElementById('pfTitle').textContent = 'ユーザー設定';
			document.getElementById('pfSubtitle').style.display = 'none';
		}
		// 初回設定モーダルはバックスタックに積まない（戻るで閉じられないようにする）
		openOverlay('ovProfile', { noHistory: firstSetup });
	}

	/* ===================== reset ===================== */

	async function resetEverything() {
		if (
			!await showConfirm(
				'全てのルームから退出し、ユーザー情報がリセットされます。',
				'本当にリセットしますか？',
			)
		)
			return;
		Object.keys(localStorage)
			.filter((k) => k.startsWith('nekochat'))
			.forEach((k) => localStorage.removeItem(k));
		history.replaceState(null, '', location.pathname);
		location.reload();
	}

	/* ===================== DOM wiring ===================== */

	document.getElementById('sidebarToggleBtn').onclick = toggleSidebar;

	document.getElementById('filePreviewClose').onclick = closeFilePreview;
	document.getElementById('ovFilePreview').addEventListener('click', (e) => {
		if (e.target && e.target.id === 'ovFilePreview') closeFilePreview();
	});

	document.getElementById('mediaFullscreenClose').onclick = () =>
		closeMediaFullscreen();
	document
		.getElementById('ovMediaFullscreen')
		.addEventListener('click', (e) => {
			if (e.target && e.target.id === 'ovMediaFullscreen')
				closeMediaFullscreen();
		});
	document
		.getElementById('mediaFullscreenStage')
		.addEventListener('dblclick', () => closeMediaFullscreen());

	// 統合バックスタックハンドラ
	window.addEventListener('popstate', (e) => {
		if (isInternalBack) {
			isInternalBack = false;
			return;
		}

		if (backStack.length > 0) {
			const item = backStack.pop();
			if (item.type === 'modal') {
				closeOverlay(item.id, { fromHistory: true });
			} else if (item.type === 'mediaFullscreen') {
				closeMediaFullscreen(true);
			} else if (item.type === 'chat') {
				setChatOpen(false, { fromHistory: true });
			} else if (item.type === 'sidebarClosed') {
				setSidebarOpen(true, { fromHistory: true });
				if (App.roomId) {
					leaveCurrentRoom();
				}
			}
			return;
		}

		// URL変化（ルーム移動など）
		handleLocationChange();
	});
	document.getElementById('sidebarCloseBtn').onclick = () =>
		setSidebarOpen(false);
	document.getElementById('vcChatBtn').onclick = toggleChat;
	document.getElementById('chatCloseBtn').onclick = () => setChatOpen(false);

	document.getElementById('newRoomBtn').onclick = openCreateModal;

	const socialBtnEl = document.getElementById('socialBtn');
	if (socialBtnEl) socialBtnEl.onclick = openSocialModal;
	const socialCloseBtn = document.getElementById('socialClose');
	if (socialCloseBtn)
		socialCloseBtn.onclick = () =>
			closeOverlay('ovSocial', { noHistoryBack: true });

	document.getElementById('tabCreate').onclick = () =>
		showCreateTab('create');
	document.getElementById('tabJoin').onclick = () => showCreateTab('join');
	document.getElementById('crCancel').onclick = () =>
		closeOverlay('ovCreate');
	document.getElementById('crSubmit').onclick = () => {
		const name =
			document.getElementById('crName').value.trim() || '無題のスペース';
		const persist = !document.getElementById('crPersist').checked;
		closeOverlay('ovCreate', { noHistoryBack: true });
		createRoom(name, persist);
	};
	document.getElementById('jnCancel').onclick = () =>
		closeOverlay('ovCreate');
	document.getElementById('jnSubmit').onclick = () => {
		const raw = document.getElementById('jnLink').value.trim();
		const m = raw.match(/r=([A-Za-z0-9\-]+)/);
		const roomId = m ? m[1] : /^[A-Za-z0-9\-]+$/.test(raw) ? raw : null;
		if (!roomId) {
			document.getElementById('jnErr').textContent =
				'招待リンクまたはスペースIDの形式が正しくありません';
			return;
		}
		closeOverlay('ovCreate', { noHistoryBack: true });

		const known =
			RoomStore.list().find((r) => r.id === roomId) ||
			(App.ephemeral && App.ephemeral.id === roomId
				? App.ephemeral
				: null);
		openRoom(
			roomId,
			known ? known.name : '',
			known ? known.persist : true,
			!known,
		);
	};

	document.getElementById('headerInfo').onclick = openRoomSettings;
	document.getElementById('rsCancel').onclick = () =>
		closeOverlay('ovRoomSettings');
	document.getElementById('rsSave').onclick = () => {
		const name =
			document.getElementById('rsName').value.trim() || '無題のスペース';
		const persist = !document.getElementById('rsPersist').checked;
		closeOverlay('ovRoomSettings');
		updateRoomOption({ name, persist });
	};
	document.getElementById('rsCopy').onclick = () => {
		const v = document.getElementById('rsLink').value;
		navigator.clipboard
			.writeText(v)
			.then(() => toast('招待リンクをコピーしました'))
			.catch(() => toast(v));
	};
	document.getElementById('rsLeave').onclick = async () => {
		if (!await showConfirm('このスペースから退出しますか？')) return;
		const roomIdToLeave = App.roomId;
		leaveCurrentRoom();
		// ルーム退出時にルーム一覧から該当IDを削除
		if (roomIdToLeave) {
			RoomStore.remove(roomIdToLeave);
			renderRoomList();
		}
		closeOverlay('ovRoomSettings', { noHistoryBack: true });
	};

	document.getElementById('onlineBadge').onclick = (e) => {
		e.stopPropagation();
		const pop = document.getElementById('userPopover');
		pop.style.display = pop.style.display === 'block' ? 'none' : 'block';
	};
	document.addEventListener('click', (e) => {
		const pop = document.getElementById('userPopover');
		if (
			pop.style.display === 'block' &&
			!pop.contains(e.target) &&
			e.target.id !== 'onlineBadge'
		)
			pop.style.display = 'none';
	});

	document.getElementById('sidebarFooter').onclick = openProfileModal;
	document.getElementById('pfCancel').onclick = () =>
		closeOverlay('ovProfile');
	document.getElementById('pfImagePick').onclick = () =>
		document.getElementById('pfImageInput').click();
	document.getElementById('pfImageInput').addEventListener('change', (e) => {
		const f = e.target.files[0];
		if (f) handleImagePick(f);
		e.target.value = '';
	});
	document.getElementById('pfImageClear').onclick = () => {
		Profile.image = null;
		applyAvatarEl(document.getElementById('pfAvatarPreview'), Profile);
	};
	// ユーザー名入力時のリアルタイムアバター更新
	document.getElementById('pfName').addEventListener('input', (e) => {
		const tempProfile = {
			...Profile,
			name: e.target.value.trim(),
		};
		applyAvatarEl(document.getElementById('pfAvatarPreview'), tempProfile);
	});

	document.getElementById('pfSave').onclick = () => {
		const name = document.getElementById('pfName').value.trim();
		if (!name) {
			toast('表示名を入力してください');
			return;
		}
		const isFirstSetup = document.getElementById('ovProfile').classList.contains('firstSetup');
		Profile.name = name;
		saveProfile();
		renderSidebarFooter();
		// 初回設定モードを解除してから閉じる
		document.getElementById('ovProfile').classList.remove('firstSetup');
		closeOverlay('ovProfile');
		renderLog();
		if (App.connected) {
			setOwnVoiceOption({
				name: myMeta().name,
				image: Profile.image,
			});
		}
		if (isFirstSetup) {
			const r =
				new URLSearchParams(location.search).get('r') ||
				new URLSearchParams(location.hash.replace(/^#/, '')).get('r');
			if (r && verifyAndFallback(r)) {
				const known =
					RoomStore.list().find((x) => x.id === r) ||
					(App.ephemeral && App.ephemeral.id === r
						? App.ephemeral
						: null);
				openRoom(
					r,
					known ? known.name : '',
					known ? known.persist : true,
					!known,
				);
			}
		}
	};
	document.getElementById('pfReset').onclick = resetEverything;

	document.getElementById('btnSend').onclick = sendTextMessage;
	document.getElementById('replyBarClose').onclick = cancelReply;
	const msgInput = document.getElementById('msgInput');
	msgInput.addEventListener('keydown', (e) => {
		if (e.key === 'Enter' && e.ctrlKey) {
			e.preventDefault();
			sendTextMessage();
		}
	});
	msgInput.addEventListener('input', () => {
		msgInput.style.height = 'auto';
		msgInput.style.height = Math.min(120, msgInput.scrollHeight) + 'px';
		if (msgInput.value.trim()) {
			TypingState.startTyping();
			App._captionTyping.set(Identity.id, true);
		} else {
			TypingState.stopTyping();
			App._captionTyping.delete(Identity.id);
		}
	});
	// IME入力中（変換中）もinputの前に入力中状態を送信する
	msgInput.addEventListener('compositionstart', () => {
		TypingState.startTyping();
		App._captionTyping.set(Identity.id, true);
	});
	msgInput.addEventListener('compositionupdate', () => {
		TypingState.startTyping();
		App._captionTyping.set(Identity.id, true);
	});
	msgInput.addEventListener('blur', () => {
		TypingState.stopTyping();
		App._captionTyping.delete(Identity.id);
	});

	document.getElementById('btnAttach').onclick = () =>
		document.getElementById('fileInput').click();
	document.getElementById('fileInput').addEventListener('change', (e) => {
		const f = e.target.files[0];
		if (f) sendFile(f);
		e.target.value = '';
	});

	document.getElementById('vcJoinBtn').onclick = () => {
		if (App.localStream) return;
		openVoiceJoinModal();
	};
	// ボイス参加モーダル配線
	const vjCancelBtn = document.getElementById('vjCancel');
	if (vjCancelBtn) vjCancelBtn.onclick = closeVoiceJoinModal;
	const vjJoinBtn = document.getElementById('vjJoin');
	if (vjJoinBtn)
		vjJoinBtn.onclick = async () => {
			const errEl = document.getElementById('vjErr');
			if (errEl) errEl.textContent = '';
			const micEnabled =
				!!document.getElementById('vjMicEnable')?.checked;
			const camEnabled =
				!!document.getElementById('vjCamEnable')?.checked;
			const micId = document.getElementById('vjMicSelect')?.value || '';
			const camId = document.getElementById('vjCamSelect')?.value || '';
			// マイク/カメラの選択を次回のために保存
			try {
				localStorage.setItem(
					'nc_voice_pref',
					JSON.stringify({
						mic: micEnabled,
						cam: camEnabled,
						audioDeviceId: micId || undefined,
						videoDeviceId: camId || undefined,
					}),
				);
			} catch (e) {}
			closeVoiceJoinModal();
			await doJoinVoiceChatWithDevices({
				audio: micEnabled,
				video: camEnabled,
				audioDeviceId: micId || undefined,
				videoDeviceId: camId || undefined,
			});
		};
	document.getElementById('ovVoiceJoin').addEventListener('click', (e) => {
		if (e.target && e.target.id === 'ovVoiceJoin') closeVoiceJoinModal();
	});
	document.getElementById('vcLeaveBtn').onclick = leaveVoiceChat;
	document.getElementById('vcMuteBtn').onclick = toggleMute;
	document.getElementById('vcCamBtn').onclick = toggleCamera;
	document.getElementById('vcShareBtn').onclick = toggleScreenShare;
	document.getElementById('vcCaptionBtn').onclick = () => {
		App.captionsOn = !App.captionsOn;
		// B6 fix: setOwnVoiceOption が async で renderVoiceScreen/renderVoiceToolbar を内包するため
		// ここで重複して renderVoiceToolbar を呼ばない。即時反映のためツールバーのみ先に更新。
		renderVoiceToolbar();
		if (App.captionsOn && App.localStream) {
			startSpeechRecognition();
			startCaptionDotTimer();
		} else {
			stopSpeechRecognition();
			stopCaptionDotTimer();
		}
		setOwnVoiceOption({ captionsOn: App.captionsOn });
	};
	document.getElementById('vcTtsBtn').onclick = () => {
		App.ttsOn = !App.ttsOn;
		// B6 fix: captionBtn と同様に即時反映のため先にツールバー更新
		renderVoiceToolbar();
		setOwnVoiceOption({ ttsOn: App.ttsOn });
	};

	window.addEventListener('beforeunload', () => resetConnectionState());

	window.addEventListener('online', () => {
		if (App.peer && !App.peer.destroyed) {
			try {
				App.peer.reconnect();
			} catch (e) {}
		}
	});

	// URL変化（ルーム移動など）の共通処理
	// ※popstateハンドラからnkなしの場合に呼ばれる、またはhashchangeから呼ばれる
	function handleLocationChange() {
		applySimpleMode();
		// 正規クエリパラメータ優先、ハッシュ疑似パラメータは後方互換
		const qp = new URLSearchParams(location.search);
		const hqp = new URLSearchParams(location.hash.replace(/^#/, ''));
		const r = qp.get('r') || hqp.get('r');
		if (r) {
			if (r === App.roomId) return;
			if (verifyAndFallback(r)) {
				const known =
					RoomStore.list().find((x) => x.id === r) ||
					(App.ephemeral && App.ephemeral.id === r
						? App.ephemeral
						: null);
				openRoom(
					r,
					known ? known.name : '',
					known ? known.persist : true,
					!known,
				);
			}
		} else {
			if (App.roomId) leaveCurrentRoom();
		}
	}
	// ハッシュ変化（後方互換）もhandleLocationChangeに委譲
	window.addEventListener('hashchange', handleLocationChange);

	function renderSidebarFooter() {
		applyAvatarEl(document.getElementById('myAvatar'), Profile);
		document.getElementById('myName').textContent =
			Profile.name || '未設定';
	}

	/* ===================== boot ===================== */

	(async function boot() {
		// 正規クエリパラメータ優先、ハッシュ疑似パラメータは後方互換
		const r =
			new URLSearchParams(location.search).get('r') ||
			new URLSearchParams(location.hash.replace(/^#/, '')).get('r');

		const w = window.innerWidth;
		isMobile = w <= 768;

		let initialSidebarOpen = !isMobile || !r;
		let initialChatOpen = !isMobile;

		if (!isMobile) {
			// 縮小PCUI（769〜999px）は起動時サイドバーを開いたままにする
			// （w < 1000 でも閉じない）
			if (w < 850) initialChatOpen = false;
		}

		setSidebarOpen(initialSidebarOpen);
		setChatOpen(initialChatOpen);

		if (isMobile && !initialSidebarOpen) {
			backStack.push({ type: 'sidebarClosed' });
			history.pushState({ nk: 'sidebarClosed' }, '');
		}

		// NyaXEmoji一覧を非同期で先読み（失敗しても起動をブロックしない）
		NyaXEmoji.init();
		NyaXEmoji.onReady(() => rerenderExistingEmoji());

		await ensureIdentity();
		loadProfile();
		Profile.uid = Identity.id;
		loadUserSettings();
		UserStore.load();
		UserStore.upsertSelf();
		applySimpleMode();
		renderSidebarFooter();
		renderRoomList();

		if (!Profile.name) {
			openProfileModal({ firstSetup: true });
		}

		document.getElementById('voiceToolbar').style.display = 'none';

		if (r) {
			if (verifyAndFallback(r)) {
				const known =
					RoomStore.list().find((x) => x.id === r) ||
					(App.ephemeral && App.ephemeral.id === r
						? App.ephemeral
						: null);
				openRoom(
					r,
					known ? known.name : '',
					known ? known.persist : true,
					!known,
				);
			}
		}
	})();
});
