/**
 * Process entry for an always-on install.
 * Sets UV_THREADPOOL_SIZE before src/server.js loads fs, dns, or zlib. The libuv
 * pool is created on first use, and a value set afterwards is ignored. Hung NAS
 * reads each pin one worker; the default pool of 4 can then stall history saves
 * and static files. An environment value already set (service, shell) is kept.
 * This file emits no events.
 */
'use strict';

if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = '16';

require('./server');
