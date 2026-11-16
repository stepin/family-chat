// Where the project lives. Everything else on the site is generated from the
// repository.
//
// The documentation in docs/ names the project's own repository and image.
// A fork that publishes its own site sets its values here or through the
// environment variables in brackets; the build then writes them in place of
// the project's ones (apps/site/README.md).

/** The project's repository and image, as written in docs/. */
export const PROJECT_REPOSITORY = 'https://github.com/stepin/family-chat';
export const PROJECT_IMAGE = 'ghcr.io/stepin/fcd';

export default {
  // Public repository (SITE_REPOSITORY_URL). Releases are at <repositoryUrl>/releases.
  repositoryUrl: process.env.SITE_REPOSITORY_URL || PROJECT_REPOSITORY,
  // Docker image without a tag (SITE_IMAGE).
  image: process.env.SITE_IMAGE || PROJECT_IMAGE,
  // Path the site is served under, with slashes on both ends (SITE_BASE_PATH):
  // "/" for its own domain, "/family-chat/" for a GitHub Pages project site.
  // Only 404.html needs it (it is shown for any missing address); every other
  // page links relatively and works under any path.
  basePath: process.env.SITE_BASE_PATH ?? '/',
};
