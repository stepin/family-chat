// Values that are only known at publication. Everything else on the site is
// generated from the repository.
//
// The documentation in docs/ uses obvious placeholders for them; the site
// build replaces the placeholders with these values when they are set (either
// here or through the environment variables in brackets).

export const PLACEHOLDER_REPOSITORY = 'https://code.example.org/family-chat';
export const PLACEHOLDER_IMAGE = 'registry.example.org/family-chat/fcd';

export default {
  // Public repository, for example https://github.com/<owner>/family-chat
  // (SITE_REPOSITORY_URL). Releases are expected at <repositoryUrl>/releases.
  // Empty: not published yet, the site says so instead of linking.
  repositoryUrl: process.env.SITE_REPOSITORY_URL ?? '',
  // Published Docker image without a tag, for example ghcr.io/<owner>/fcd
  // (SITE_IMAGE). Empty: the placeholder stays in the examples.
  image: process.env.SITE_IMAGE ?? '',
  // Path the site is served under, with slashes on both ends (SITE_BASE_PATH):
  // "/" for its own domain, "/family-chat/" for a GitHub Pages project site.
  // Only 404.html needs it (it is shown for any missing address); every other
  // page links relatively and works under any path.
  basePath: process.env.SITE_BASE_PATH ?? '/',
};
