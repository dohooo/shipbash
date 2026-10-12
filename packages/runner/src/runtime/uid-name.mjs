// A local container runs as the host's uid (control-plane resolveRunAsIds),
// which the image's passwd does not list, so programs that look their user up
// (whoami, ssh, Python's getpass, Node's os.userInfo) fail. /etc/passwd is
// read-only, so the name comes from nss_wrapper, as in the official postgres
// image: every child spawned with this process's environment preloads the
// library and reads a copy of passwd that lists the uid. The copy is this
// uid's to edit, which grants nothing: setuid programs ignore the preload. In
// a Sandbox the uids are root and the shipbash user, both listed, and this
// does nothing.
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

export async function nameUnlistedUid() {
  try {
    userInfo();
    return;
  } catch {
    // The uid is unlisted; name it below.
  }
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) return;
  const passwd = join(await mkdtemp(join(tmpdir(), "shipbash-nss-")), "passwd");
  const listed = await readFile("/etc/passwd", "utf8");
  await writeFile(passwd, `${listed}sandbox:x:${String(uid)}:${String(gid)}:ShipBash sandbox:/shipbash/home:/bin/bash\n`);
  process.env.LD_PRELOAD = "libnss_wrapper.so";
  process.env.NSS_WRAPPER_PASSWD = passwd;
  process.env.NSS_WRAPPER_GROUP = "/etc/group";
}
