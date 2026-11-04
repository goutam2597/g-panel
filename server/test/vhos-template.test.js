import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildVhost, buildPhpPool } from '../src/lib/vhost-template.js';

const base = {
  domain: 'example.com',
  user: 'johndoe',
  type: 'php',
  docroot: '/home/johndoe/domains/example.com/public_html',
  phpVersion: '8.3',
  forceHttps: false,
  proxyTarget: null,
  hasCert: false
};

test('php vhost includes fastcgi to user pool socket', () => {
  const conf = buildVhost(base);
  assert.match(conf, /server_name example\.com www\.example\.com;/);
  assert.match(conf, /root \/home\/johndoe\/domains\/example\.com\/public_html;/);
  assert.match(conf, /fastcgi_pass unix:\/run\/php\/gp-johndoe\.sock;/);
  assert.match(conf, /listen 80;/);
});

test('force-https vhost redirects and serves on 443', () => {
  const conf = buildVhost({ ...base, forceHttps: true, hasCert: true });
  assert.match(conf, /return 301 https:\/\/\$host\$request_uri;/);
  assert.match(conf, /listen 443 ssl;/);
  assert.match(conf, /ssl_certificate\s+\/etc\/letsencrypt\/live\/example\.com\/fullchain\.pem/);
});

test('proxy vhost proxies to target without php', () => {
  const conf = buildVhost({ ...base, type: 'proxy', proxyTarget: 'http://127.0.0.1:32100' });
  assert.match(conf, /proxy_pass http:\/\/127\.0\.0\.1:32100;/);
  assert.doesNotMatch(conf, /fastcgi_pass/);
});

test('php pool runs as the user with sane limits', () => {
  const pool = buildPhpPool({ user: 'johndoe', phpVersion: '8.3', docrootBase: '/home/johndoe/domains', maxChildren: 8 });
  assert.match(pool, /\[gp-johndoe\]/);
  assert.match(pool, /user = johndoe/);
  assert.match(pool, /pm\.max_children = 8/);
  assert.match(pool, /open_basedir/);
});
