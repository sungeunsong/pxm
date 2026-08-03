FROM mongo:7.0
COPY infra/production/mongo-entrypoint.sh /usr/local/bin/pxm-mongo-entrypoint
COPY infra/production/mongo-init.js /docker-entrypoint-initdb.d/10-pxm-app-user.js
RUN chmod 0555 /usr/local/bin/pxm-mongo-entrypoint
ENTRYPOINT ["/usr/local/bin/pxm-mongo-entrypoint"]
CMD ["mongod", "--replSet", "rs0", "--bind_ip_all", "--auth", "--keyFile", "/data/configdb/pxm-keyfile"]
