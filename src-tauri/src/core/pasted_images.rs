// Fork (21/10/2026): every image sent in a chat message is also saved as a file in the thread's own folder,
// threads/<thread id>/immagini/, so that tools can open the picture the model sees only as image tokens, and the file
// goes when the thread is deleted (delete_thread removes the thread folder with remove_thread_dir; what a file open at
// that moment kept there goes at the next deletion or the next start: sweep_orphan_image_folders_if_needed). The code
// sandbox mounts, read-only as /immagini, the folder of the thread a tool call comes from: call_tool sends the thread
// id in the request's `_meta` (core/mcp/thread_meta.rs). The web app calls `save_pasted_image` and names the file in
// the message (web-app/src/lib/pastedImageCopies.ts); Compress thread calls `link_thread_images`
// (web-app/src/lib/compressThread.ts) so that the copied messages find their images in the new thread as well.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use std::io::{ErrorKind, Write as _};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Runtime;

use crate::core::app::commands::get_jan_data_folder_path;
use crate::core::threads::constants::{MESSAGES_FILE, THREADS_FILE};
use crate::core::threads::utils::get_thread_dir;

/// The subfolder of a thread's folder that holds its images.
pub const SUBFOLDER: &str = "immagini";

/// How many files may share a wanted name (`x.png`, `x-2.png`, ... `x-100.png`) before saving fails.
const MAX_SAME_NAME: u32 = 100;

/// A bare file or folder name: ASCII letters, digits, '-', '_' and '.', not starting or ending with '.' (Windows
/// drops a trailing '.'). The commands are reachable from the web view, so a name joined to a folder can never point
/// outside it. delete_thread checks thread ids with it too.
pub(crate) fn is_bare_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('.')
        && !name.ends_with('.')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// `thread_dir`/immagini, created when missing but never recursively: a thread folder that is not there (deleted
/// meanwhile included) is an error, and an image never creates a thread folder Jan does not know.
fn ensure_images_dir(thread_dir: &Path) -> Result<PathBuf, String> {
    let dir = thread_dir.join(SUBFOLDER);
    match std::fs::create_dir(&dir) {
        Ok(()) => Ok(dir),
        Err(e) if e.kind() == ErrorKind::AlreadyExists && dir.is_dir() => Ok(dir),
        Err(e) if e.kind() == ErrorKind::NotFound => Err(format!(
            "the thread folder {} does not exist",
            thread_dir.display()
        )),
        Err(e) => Err(format!("{}: {e}", dir.display())),
    }
}

/// The folder of thread `thread_id` (it may not exist), refusing an id that is not a bare name.
fn thread_dir<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    thread_id: &str,
) -> Result<PathBuf, String> {
    if !is_bare_name(thread_id) {
        return Err(format!("invalid thread id {thread_id:?}"));
    }
    Ok(get_thread_dir(
        &get_jan_data_folder_path(app_handle),
        thread_id,
    ))
}

/// Decodes `data_base64` and writes it in `thread_dir`/immagini as `name`, or, when that name is taken (two images
/// sent in the same second, or in the hour that repeats when clocks go back), as `<stem>-2.<ext>`, `<stem>-3.<ext>`...:
/// an image never overwrites another. Returns the name the file got.
pub fn write_image(thread_dir: &Path, name: &str, data_base64: &str) -> Result<String, String> {
    if !is_bare_name(name) {
        return Err(format!("save_pasted_image: invalid file name {name:?}"));
    }
    let bytes = BASE64
        .decode(data_base64)
        .map_err(|e| format!("save_pasted_image: the image is not valid base64: {e}"))?;
    let dir = ensure_images_dir(thread_dir).map_err(|e| format!("save_pasted_image: {e}"))?;
    let (stem, ext) = match name.rsplit_once('.') {
        Some((stem, ext)) => (stem, format!(".{ext}")),
        None => (name, String::new()),
    };
    for n in 1..=MAX_SAME_NAME {
        let candidate = if n == 1 {
            name.to_string()
        } else {
            format!("{stem}-{n}{ext}")
        };
        let path = dir.join(&candidate);
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => {
                file.write_all(&bytes)
                    .map_err(|e| format!("save_pasted_image: {}: {e}", path.display()))?;
                return Ok(candidate);
            }
            Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("save_pasted_image: {}: {e}", path.display())),
        }
    }
    Err(format!(
        "save_pasted_image: {MAX_SAME_NAME} files named {name} or a variant of it are already in {}",
        dir.display()
    ))
}

/// Hard-links every file of `from_thread_dir`/immagini into `to_thread_dir`/immagini (created when missing) and
/// returns how many: the same files on disk under both threads, each kept until the last thread that has it is
/// deleted. 0, and nothing created, when the first thread has no images; an error when its folder is missing (a
/// thread deleted meanwhile), so that images lost do not pass for no images.
pub fn link_images(from_thread_dir: &Path, to_thread_dir: &Path) -> Result<usize, String> {
    if !from_thread_dir.is_dir() {
        return Err(format!(
            "link_thread_images: the thread folder {} does not exist",
            from_thread_dir.display()
        ));
    }
    let from = from_thread_dir.join(SUBFOLDER);
    if !from.is_dir() {
        return Ok(0);
    }
    let to = ensure_images_dir(to_thread_dir).map_err(|e| format!("link_thread_images: {e}"))?;
    let entries = std::fs::read_dir(&from)
        .map_err(|e| format!("link_thread_images: {}: {e}", from.display()))?;
    let mut linked = 0;
    for entry in entries {
        let entry = entry.map_err(|e| format!("link_thread_images: {}: {e}", from.display()))?;
        let target = to.join(entry.file_name());
        std::fs::hard_link(entry.path(), &target).map_err(|e| {
            format!(
                "link_thread_images: {} -> {}: {e}",
                entry.path().display(),
                target.display()
            )
        })?;
        linked += 1;
    }
    Ok(linked)
}

/// Whether `dir` holds nothing but an images folder: no thread.json (every thread Jan knows has one), no
/// messages.jsonl, nothing else.
fn holds_only_images(dir: &Path) -> std::io::Result<bool> {
    let mut found_images = false;
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        if entry.file_name() == SUBFOLDER && entry.file_type()?.is_dir() {
            found_images = true;
        } else {
            return Ok(false);
        }
    }
    Ok(found_images)
}

/// Whether thread folders left with only images may exist: true at start (a deletion stopped in an earlier session,
/// or a sandbox call that recreated the folder of a thread deleted meanwhile, may have left one) and after a deletion
/// that could not remove everything; cleared by a sweep that removed all it found.
static SWEEP_NEEDED: AtomicBool = AtomicBool::new(true);

/// Deletes a thread's folder in an order that never leaves a deleted conversation behind unseen. On Windows a file
/// open at that moment without delete sharing (an image a viewer or the sandbox is reading, messages.jsonl in another
/// program) stops a deletion where it is, and NTFS lists `immagini` before the two files. So messages.jsonl goes
/// first, then thread.json, stopping at the first of the two that cannot go: the thread stays listed, whole or empty,
/// and can be deleted again. Jan keeps nothing else in a thread's folder (the CLI keeps its threads in its own store,
/// ~/.jan/projects), so what a stop leaves after that is a folder with only images, removed by the next sweep
/// (sweep_orphan_image_folders_if_needed). Failures are logged.
pub fn remove_thread_dir(thread_dir: &Path) {
    for name in [MESSAGES_FILE, THREADS_FILE] {
        let path = thread_dir.join(name);
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == ErrorKind::NotFound => {}
            Err(e) => {
                log::warn!("delete_thread: {}: {e}", path.display());
                return;
            }
        }
    }
    if let Err(e) = std::fs::remove_dir_all(thread_dir) {
        log::warn!("delete_thread: {}: {e}", thread_dir.display());
        SWEEP_NEEDED.store(true, Ordering::Release);
    }
}

/// Sweeps `threads_dir` when a folder with only images may have been left (SWEEP_NEEDED): once at start (lib.rs,
/// setup), and at the next deletion after one that stopped. Called by delete_thread too; "Delete all", which starts
/// one deletion per thread together, sweeps once instead of once per thread.
pub fn sweep_orphan_image_folders_if_needed(threads_dir: &Path) {
    sweep_when_needed(&SWEEP_NEEDED, threads_dir);
}

fn sweep_when_needed(needed: &AtomicBool, threads_dir: &Path) {
    if needed.swap(false, Ordering::AcqRel) && !sweep_orphan_image_folders(threads_dir) {
        needed.store(true, Ordering::Release);
    }
}

/// Removes the folders in `threads_dir` that hold nothing but an images folder: what is left when deleting a thread
/// stopped at an image that was open at that moment (Windows does not delete a file in use), or a folder recreated by
/// a bind mount of a thread deleted meanwhile. A thread Jan knows always has its thread.json, so it is never touched.
/// Returns whether everything found was removed (true when there is no threads folder yet: the first start, before
/// Jan creates it); what could not be is logged.
fn sweep_orphan_image_folders(threads_dir: &Path) -> bool {
    let entries = match std::fs::read_dir(threads_dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == ErrorKind::NotFound => return true,
        Err(e) => {
            log::warn!("sweep_orphan_image_folders: {}: {e}", threads_dir.display());
            return false;
        }
    };
    let mut complete = true;
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(e) => {
                log::warn!("sweep_orphan_image_folders: {}: {e}", threads_dir.display());
                complete = false;
                continue;
            }
        };
        let dir = entry.path();
        match entry.file_type() {
            Ok(file_type) if file_type.is_dir() => {}
            // a stray file: not a thread folder
            Ok(_) => continue,
            Err(e) => {
                log::warn!("sweep_orphan_image_folders: {}: {e}", dir.display());
                complete = false;
                continue;
            }
        }
        match holds_only_images(&dir) {
            Ok(true) => match std::fs::remove_dir_all(&dir) {
                Ok(()) => {}
                // removed meanwhile by the deletion of that very thread
                Err(e) if e.kind() == ErrorKind::NotFound => {}
                Err(e) => {
                    log::warn!("sweep_orphan_image_folders: {}: {e}", dir.display());
                    complete = false;
                }
            },
            Ok(false) => {}
            // removed meanwhile by the deletion of that very thread
            Err(e) if e.kind() == ErrorKind::NotFound => {}
            Err(e) => {
                log::warn!("sweep_orphan_image_folders: {}: {e}", dir.display());
                complete = false;
            }
        }
    }
    complete
}

/// Saves a pasted image in threads/<thread_id>/immagini and returns the name the file got (the name asked for, or a
/// variant of it when that one is taken).
#[tauri::command]
pub async fn save_pasted_image<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    thread_id: String,
    name: String,
    data_base64: String,
) -> Result<String, String> {
    let dir = thread_dir(app_handle, &thread_id).map_err(|e| format!("save_pasted_image: {e}"))?;
    write_image(&dir, &name, &data_base64)
}

/// Hard-links the images of thread `from_thread_id` into thread `to_thread_id` (Compress thread); returns how many.
#[tauri::command]
pub async fn link_thread_images<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    from_thread_id: String,
    to_thread_id: String,
) -> Result<usize, String> {
    let from = thread_dir(app_handle.clone(), &from_thread_id)
        .map_err(|e| format!("link_thread_images: {e}"))?;
    let to =
        thread_dir(app_handle, &to_thread_id).map_err(|e| format!("link_thread_images: {e}"))?;
    link_images(&from, &to)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An empty scratch folder for one test, standing for the data folder's `threads`.
    fn fresh_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("jan-pasted-images-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A thread folder that exists, as Jan creates it with the thread.
    fn thread(root: &Path, id: &str) -> PathBuf {
        let dir = root.join(id);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn writes_the_decoded_bytes_in_the_thread_images_folder() {
        let root = fresh_dir("write");
        let t = thread(&root, "72119d07-1403-4ab3-ba4f-14db831ad87d");
        let name = write_image(&t, "2026-10-21_101500_1.png", "iVBORw0KGgo=").unwrap();
        assert_eq!(name, "2026-10-21_101500_1.png");
        assert_eq!(
            std::fs::read(t.join("immagini").join(&name)).unwrap(),
            b"\x89PNG\r\n\x1a\n"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn refuses_a_thread_folder_that_does_not_exist() {
        let root = fresh_dir("nothread");
        let missing = root.join("not-a-thread");
        assert!(write_image(&missing, "x.png", "AAAA")
            .unwrap_err()
            .contains("does not exist"));
        assert!(!missing.exists(), "no thread folder is created");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_taken_name_gets_a_suffix_and_nothing_is_overwritten() {
        let root = fresh_dir("taken");
        let t = thread(&root, "t1");
        assert_eq!(
            write_image(&t, "2026-10-25_023015_1.png", "AAAA").unwrap(),
            "2026-10-25_023015_1.png"
        );
        assert_eq!(
            write_image(&t, "2026-10-25_023015_1.png", "iVBORw0KGgo=").unwrap(),
            "2026-10-25_023015_1-2.png"
        );
        assert_eq!(
            write_image(&t, "2026-10-25_023015_1.png", "AAAA").unwrap(),
            "2026-10-25_023015_1-3.png"
        );
        let images = t.join("immagini");
        assert_eq!(
            std::fs::read(images.join("2026-10-25_023015_1.png")).unwrap(),
            [0u8, 0, 0],
            "the first file is left as it was"
        );
        assert_eq!(
            std::fs::read(images.join("2026-10-25_023015_1-2.png")).unwrap(),
            b"\x89PNG\r\n\x1a\n"
        );
        assert_eq!(write_image(&t, "noext", "AAAA").unwrap(), "noext");
        assert_eq!(write_image(&t, "noext", "AAAA").unwrap(), "noext-2");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn stops_after_max_same_name_files() {
        let root = fresh_dir("max");
        let t = thread(&root, "t1");
        for _ in 0..MAX_SAME_NAME {
            write_image(&t, "x.png", "AAAA").unwrap();
        }
        assert!(write_image(&t, "x.png", "AAAA")
            .unwrap_err()
            .contains("already in"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn refuses_names_that_are_not_bare_file_names() {
        let root = fresh_dir("names");
        let t = thread(&root, "t1");
        for name in [
            "", ".png", "..", "../x.png", "a/b.png", "a\\b.png", "C:x.png", "x y.png", "x.png.",
        ] {
            assert!(
                write_image(&t, name, "AAAA").is_err(),
                "{name:?} was accepted"
            );
            assert!(!is_bare_name(name), "{name:?} counts as a bare name");
        }
        assert!(
            !t.join("immagini").exists(),
            "nothing is created for a refused name"
        );
        assert!(
            is_bare_name("72119d07-1403-4ab3-ba4f-14db831ad87d"),
            "a thread id is a bare name"
        );
        assert!(is_bare_name("01JAN5Z3Q9X0ABCDEFGHJKMNPQ"), "a ulid too");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn refuses_data_that_is_not_base64() {
        let root = fresh_dir("b64");
        let t = thread(&root, "t1");
        assert!(write_image(&t, "x.png", "not base64!").is_err());
        assert!(
            !t.join("immagini").exists(),
            "nothing is created for data that is not base64"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn links_the_images_into_the_new_thread_and_they_outlive_the_old_one() {
        let root = fresh_dir("link");
        let old = thread(&root, "old");
        let new = thread(&root, "new");
        write_image(&old, "a.png", "iVBORw0KGgo=").unwrap();
        write_image(&old, "b.jpg", "AAAA").unwrap();
        assert_eq!(link_images(&old, &new).unwrap(), 2);
        // what delete_thread does to the old thread
        std::fs::remove_dir_all(&old).unwrap();
        assert_eq!(
            std::fs::read(new.join("immagini").join("a.png")).unwrap(),
            b"\x89PNG\r\n\x1a\n"
        );
        assert_eq!(
            std::fs::read(new.join("immagini").join("b.jpg")).unwrap(),
            [0u8, 0, 0]
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn links_nothing_when_the_old_thread_has_no_images() {
        let root = fresh_dir("noimages");
        let old = thread(&root, "old");
        let new = thread(&root, "new");
        assert_eq!(link_images(&old, &new).unwrap(), 0);
        assert!(
            !new.join("immagini").exists(),
            "no empty folder in the new thread"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn refuses_to_link_from_a_thread_folder_that_does_not_exist() {
        let root = fresh_dir("linkfrommissing");
        let new = thread(&root, "new");
        assert!(link_images(&root.join("deleted"), &new)
            .unwrap_err()
            .contains("does not exist"));
        assert!(
            !new.join("immagini").exists(),
            "nothing is created in the new thread"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn refuses_to_link_into_a_thread_folder_that_does_not_exist() {
        let root = fresh_dir("linkmissing");
        let old = thread(&root, "old");
        write_image(&old, "a.png", "AAAA").unwrap();
        assert!(link_images(&old, &root.join("missing")).is_err());
        assert!(
            !root.join("missing").exists(),
            "no thread folder is created"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn removes_a_thread_folder_with_its_images() {
        let root = fresh_dir("remove");
        let t = thread(&root, "t1");
        std::fs::write(t.join("thread.json"), "{}").unwrap();
        std::fs::write(t.join("messages.jsonl"), "").unwrap();
        write_image(&t, "a.png", "AAAA").unwrap();
        remove_thread_dir(&t);
        assert!(!t.exists());
        // a thread with no message yet, and a folder already gone
        let fresh = thread(&root, "t2");
        std::fs::write(fresh.join("thread.json"), "{}").unwrap();
        remove_thread_dir(&fresh);
        assert!(!fresh.exists());
        remove_thread_dir(&root.join("gone"));
        let _ = std::fs::remove_dir_all(root);
    }

    // In the next two tests a folder stands where a file should be: remove_file fails on it, as on a file in use on
    // Windows.

    #[test]
    fn deletes_nothing_when_messages_cannot_be_deleted() {
        let root = fresh_dir("keepall");
        let t = thread(&root, "t1");
        std::fs::write(t.join("thread.json"), "{}").unwrap();
        std::fs::create_dir(t.join("messages.jsonl")).unwrap();
        write_image(&t, "a.png", "AAAA").unwrap();
        remove_thread_dir(&t);
        assert!(
            t.join("thread.json").exists(),
            "the thread comes back whole"
        );
        assert!(t.join("immagini").join("a.png").exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn stops_at_thread_json_when_it_cannot_be_deleted() {
        let root = fresh_dir("keepthread");
        let t = thread(&root, "t1");
        std::fs::create_dir(t.join("thread.json")).unwrap();
        std::fs::write(t.join("messages.jsonl"), "x").unwrap();
        write_image(&t, "a.png", "AAAA").unwrap();
        remove_thread_dir(&t);
        assert!(!t.join("messages.jsonl").exists(), "the messages go first");
        assert!(
            t.join("thread.json").exists(),
            "the thread comes back, empty"
        );
        assert!(t.join("immagini").join("a.png").exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn the_sweep_removes_only_folders_left_with_nothing_but_images() {
        let root = fresh_dir("sweep");
        // what a deletion stopped by an open image leaves
        let orphan = thread(&root, "orphan");
        write_image(&orphan, "a.png", "AAAA").unwrap();
        // what a bind mount of a deleted thread recreates: an empty images folder
        let recreated = thread(&root, "recreated");
        std::fs::create_dir(recreated.join("immagini")).unwrap();
        // live threads, with and without images
        let live = thread(&root, "live");
        std::fs::write(live.join("thread.json"), "{}").unwrap();
        write_image(&live, "b.png", "AAAA").unwrap();
        let plain = thread(&root, "plain");
        std::fs::write(plain.join("thread.json"), "{}").unwrap();
        std::fs::write(plain.join("messages.jsonl"), "").unwrap();
        // messages written without thread.json (a thread whose creation failed): not ours to remove
        let unlisted = thread(&root, "unlisted");
        std::fs::write(unlisted.join("messages.jsonl"), "").unwrap();
        write_image(&unlisted, "c.png", "AAAA").unwrap();
        // a thread folder being created (thread.json not written yet), and a stray file
        let creating = thread(&root, "creating");
        std::fs::write(root.join("stray.txt"), "").unwrap();

        assert!(
            sweep_orphan_image_folders(&root),
            "everything found was removed"
        );

        assert!(!orphan.exists(), "orphan images removed");
        assert!(!recreated.exists(), "recreated folder removed");
        assert!(
            live.join("immagini").join("b.png").exists(),
            "live thread kept"
        );
        assert!(plain.join("messages.jsonl").exists(), "plain thread kept");
        assert!(
            unlisted.join("immagini").join("c.png").exists(),
            "messages kept"
        );
        assert!(creating.exists(), "folder being created kept");
        assert!(root.join("stray.txt").exists(), "stray file kept");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn sweeps_only_when_needed_and_again_after_a_sweep_that_did_not_finish() {
        let root = fresh_dir("needed");
        let needed = AtomicBool::new(true);
        // a sweep that cannot read the threads folder (here a file stands in its place) leaves the flag set, for the
        // next deletion
        std::fs::write(root.join("not-a-folder"), "").unwrap();
        sweep_when_needed(&needed, &root.join("not-a-folder"));
        assert!(needed.load(Ordering::Acquire));
        // no threads folder yet (first start): nothing to sweep
        sweep_when_needed(&needed, &root.join("missing"));
        assert!(!needed.load(Ordering::Acquire));
        needed.store(true, Ordering::Release);
        // a sweep that removed everything clears it
        let orphan = thread(&root, "orphan");
        write_image(&orphan, "a.png", "AAAA").unwrap();
        sweep_when_needed(&needed, &root);
        assert!(!orphan.exists());
        assert!(!needed.load(Ordering::Acquire));
        // and no sweep runs until it is set again
        let later = thread(&root, "later");
        write_image(&later, "b.png", "AAAA").unwrap();
        sweep_when_needed(&needed, &root);
        assert!(later.exists(), "no sweep while not needed");
        needed.store(true, Ordering::Release);
        sweep_when_needed(&needed, &root);
        assert!(!later.exists());
        let _ = std::fs::remove_dir_all(root);
    }
}
