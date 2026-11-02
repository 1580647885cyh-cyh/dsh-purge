// Local policy: preserve this editable 1.1.71 build, including local fixes.
// There is intentionally no panel/config/force option to bypass this lock.
export const REMOTE_UPDATES_LOCKED = true;
export const LOCKED_VERSION = "1.1.71";
export const LOCAL_LOCK_MESSAGE = "dsh-purge 已锁定到本地 1.1.71：禁止远程更新、切换版本和回滚；可以直接编辑本地源码。";

export function assertRemoteUpdatesAllowed() {
  if (!REMOTE_UPDATES_LOCKED) return;
  const error = new Error(LOCAL_LOCK_MESSAGE);
  error.code = "ERR_DSH_PURGE_LOCAL_VERSION_LOCK";
  throw error;
}

export function localLockedUpdateStatus(version = LOCKED_VERSION) {
  return {
    ok: true,
    locked: true,
    lockedVersion: LOCKED_VERSION,
    localVersion: version,
    remoteVersion: version,
    localSha: "",
    remoteSha: "",
    hasUpdate: false,
    hasBeta: false,
    pinned: true,
    pin: LOCKED_VERSION,
    channel: "stable",
    channelLabel: "本地锁定",
    updateTarget: "local",
    via: "local-lock",
    versions: [{ id: LOCKED_VERSION, ref: "local", version, channel: "stable", current: true, latest: true }],
    lanes: {
      stable: { id: "stable", ref: "local", version, sha: "", current: true, hasUpdate: false, hasRemote: false },
      beta: { id: "beta", ref: "local", version: "", sha: "", current: false, hasUpdate: false, hasRemote: false },
    },
    error: "",
    note: LOCAL_LOCK_MESSAGE,
  };
}
