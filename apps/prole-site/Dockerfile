FROM nginx:alpine

# Static site
COPY index.html styles.css /usr/share/nginx/html/
COPY assets/ /usr/share/nginx/html/assets/

# Server config (landing page + /download artifact location)
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Ensure the release mount point exists even before the first DMG is uploaded,
# so nginx returns a clean 404 for the file rather than failing on a missing dir.
RUN mkdir -p /srv/prole-releases

EXPOSE 80
