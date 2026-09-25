/*
 * Deleting a scene. `preview` says what would go; the page asks twice,
 * then calls `remove`.
 *
 *   - The file: on by default, or the next scan brings the scene back.
 *   - Galleries: off by default, listed by name.
 *   - Clips: our /markerclips/<marker>.mp4 files.
 *
 * Order: read markers first (clip names use their ids), then clips and
 * galleries, then the scene last. Whisparr isn't told.
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
