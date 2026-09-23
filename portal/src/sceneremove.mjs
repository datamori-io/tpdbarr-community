/*
 * Deleting a scene, and everything that was made from it.
 *
 * The one irreversible thing in this half of the app, so it is the one that
 * says what it is about to do before it does it. `preview` is that sentence:
 * the file and its size, the galleries filed against the scene, and how many
 * reel clips were cut from its markers. The page shows that, asks twice, and
 * only then calls `remove`.
 *
 * Three things go, and each is asked for separately because they are three
 * different losses:
 *
 *   - **The file.** Left alone unless asked for, but asked for by default: a
 *     scene deleted from Stash with its file still under a library path comes
 *     back on the next scan, so a record-only delete mostly undoes itself.
 *     The same argument the gallery delete already makes about its folder.
 *   - **Galleries.** A photo set is its own thing that happens to be tied to
 *     this scene, so it is off by default and listed by name.
 *   - **Clips.** Ours, not Stash's — /markerclips/<marker>.mp4, cut from the
 *     file that is going. Nothing else can play them once the scene is gone.
 *
 * Order matters. Markers are read *before* the scene is destroyed, because
 * they go with it and their ids are how the clips are named; the clips and the
 * galleries go next; the scene goes last, so a failure part-way leaves the
 * record that says what happened rather than an orphan.
 *
 * Whisparr is not told. Nothing here touches it — the pipeline's own delete
 * runs the other way round, from Stash outward, and a portal that quietly
 * unmonitored things on your behalf would be a second opinion nobody asked
 * for.
 */

import { gql } from './stash.mjs';
import * as gal from './galleries.mjs';
import * as markerclips from './markerclips.mjs';
import { forgetRails } from './stashlib.mjs';

const WHAT = `
  id title
  files { path size }
  scene_markers { id title seconds }
`;

async function look(config, id) {
  const data = await gql(config, `query($id: ID!) { findScene(id: $id) { ${WHAT} } }`, { id });
  if (!data.findScene) throw new Error('Stash has no scene with that id.');
  return data.findScene;
}

const basename = (path) => String(path || '').split(/[\/]/).pop() || null;

export async function preview(config, id) {
  const [scene, attached] = await Promise.all([
    look(config, id),
    gal.attached(config, { scene: id }).catch(() => ({ galleries: [] })),
  ]);

  const markers = (scene.scene_markers || []).map((m) => m.id);
  const cut = await Promise.all(markers.map((markerId) => markerclips.has(markerId)));

  return {
    id: scene.id,
    title: scene.title || basename(scene.files?.[0]?.path) || `Scene ${scene.id}`,
    files: (scene.files || []).map((f) => ({ path: f.path, size: f.size })),
    markers: markers.length,
    clips: cut.filter(Boolean).length,
    galleries: (attached.galleries || []).map((g) => ({
      id: g.id,
      title: g.title,
      images: g.images,
    })),
  };
}

export async function remove(config, id, { file = false, galleries = false, clips = true } = {}) {
  const scene = await look(config, id);
  const markers = (scene.scene_markers || []).map((m) => m.id);

  const gone = { clips: 0, galleries: 0, file: Boolean(file) };

  if (clips && markers.length) {
    gone.clips = await markerclips.remove(markers);
  }

  if (galleries) {
    const attached = await gal.attached(config, { scene: id }).catch(() => ({ galleries: [] }));
    for (const gallery of attached.galleries || []) {
      // The folder goes with it, for the same reason it does from the pencil:
      // leave it and Stash rebuilds the gallery on its next scan.
      await gal.destroy(config, gallery.id, { files: true });
      gone.galleries++;
    }
  }

  await gql(
    config,
    'mutation($input: SceneDestroyInput!) { sceneDestroy(input: $input) }',
    { input: { id, delete_file: Boolean(file), delete_generated: true } }
  );

  // The shelf, the rails and the counts all just moved.
  forgetRails();

  return { removed: true, id, ...gone };
}
