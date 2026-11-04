// nginx vhost template generator. Pure — shared by real driver, simulator and tests.
// fastcgiTarget: Linux "unix:/run/php/gp-<user>.sock" or Windows "127.0.0.1:9100".

export function buildVhost({ domain, user, type, docroot, phpVersion, forceHttps, proxyTarget, hasCert, fastcgiTarget, listenPort = 80, serverNames = null }) {
  const names = Array.isArray(serverNames) && serverNames.length ? serverNames : [domain, `www.${domain}`];
  const serverName = names.join(' ');
  const isWin = /^[a-z]:\//i.test(docroot || '');
  const logDir = isWin ? `${docroot.replace(/\/public_html$/, '')}/logs` : `/home/${user}/logs`;
  const sock = fastcgiTarget || (isWin ? '127.0.0.1:9100' : `unix:/run/php/gp-${user}.sock`);
  const sslLines = hasCert
    ? `
    listen 443 ssl;
    http2 on;
    ssl_certificate     /etc/letsencrypt/live/${domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;`
    : '';

  const common = `    root ${docroot};
    index index.php index.html index.htm;
    server_name ${serverName};
    access_log ${logDir}/${domain}-access.log;
    error_log  ${logDir}/${domain}-error.log;
    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options SAMEORIGIN always;
    client_max_body_size 512m;
    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }
    location ~ /\\.(?!well-known) {
        deny all;
    }
    location = /favicon.ico { access_log off; log_not_found off; }
`;

  if (type === 'proxy') {
    return `# G-Panel vhost: ${domain} (proxy)
server {
    listen ${listenPort};
    listen [::]:${listenPort};
    server_name ${serverName};
    access_log ${logDir}/${domain}-access.log;
    error_log  ${logDir}/${domain}-error.log;
    location / {
        proxy_pass ${proxyTarget};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }
}
`;
  }

  if (!forceHttps || !hasCert) {
    return `# G-Panel vhost: ${domain} (${type})
server {
    listen ${listenPort};
    listen [::]:${listenPort};${sslLines}
${common}${phpBlock(type, phpVersion, sock)}}
`;
  }

  // force https: port 80 redirects (except ACME), 443 serves
  return `# G-Panel vhost: ${domain} (${type}, https)
server {
    listen ${listenPort};
    listen [::]:${listenPort};
    server_name ${serverName};
    location ^~ /.well-known/acme-challenge/ {
        root ${docroot};
    }
    location / {
        return 301 https://$host$request_uri;
    }
}
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    ssl_certificate     /etc/letsencrypt/live/${domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
${common}${phpBlock(type, phpVersion, sock)}}
`;
}

function phpBlock(type, phpVersion, sock) {
  if (type !== 'php') return '';
  // Linux: Debian's fastcgi-php snippet. Windows: nginx ships fastcgi_params
  // in conf/ — SCRIPT_FILENAME must be set explicitly for php-cgi.
  const isWin = !String(sock).startsWith('unix:');
  const fastcgiSetup = isWin
    ? `        include fastcgi_params;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;`
    : '        include snippets/fastcgi-php.conf;';
  return `
    location ~ \\.php$ {
        fastcgi_pass ${sock};
${fastcgiSetup}
        fastcgi_param PHP_VALUE "upload_max_filesize=512M \\n post_max_size=512M";
    }
`;
}

export function buildPhpPool({ user, phpVersion, docrootBase, maxChildren = 8 }) {
  return `; G-Panel PHP-FPM pool: ${user}
[gp-${user}]
user = ${user}
group = ${user}
listen = /run/php/gp-${user}.sock
listen.owner = www-data
listen.group = www-data
pm = dynamic
pm.max_children = ${maxChildren}
pm.start_servers = 2
pm.min_spare_servers = 1
pm.max_spare_servers = ${Math.max(2, Math.floor(maxChildren / 2))}
php_admin_value[error_log] = /home/${user}/logs/php-error.log
php_admin_flag[log_errors] = on
php_admin_value[open_basedir] = ${docrootBase}:/tmp
php_admin_value[upload_max_filesize] = 512M
php_admin_value[post_max_size] = 512M
php_admin_value[memory_limit] = 256M
`;
}
