'use strict';

var async = require('async'),
	winston = require('winston'),
	cron = require('cron').CronJob,
	nconf = require('nconf'),
	validator = require('validator'),

	db = require('./database'),
	utils = require('../public/src/utils'),
	events = require('./events'),
	User = require('./user'),
	groups = require('./groups'),
	meta = require('./meta'),
	plugins = require('./plugins');

(function(Notifications) {

	Notifications.init = function() {
		if (process.env.NODE_ENV === 'development') {
			winston.info('[notifications.init] Registering jobs.');
		}
		new cron('0 0 * * *', Notifications.prune, null, true);
	};

	Notifications.get = function(nid, uid, callback) {
		db.exists('notifications:' + nid, function(err, exists) {
			if (err) {
				winston.error('[notifications.get] Could not retrieve nid ' + nid + ': ' + err.message);
				return callback(null);
			}

			if (exists) {
				db.sortedSetRank('uid:' + uid + ':notifications:read', nid, function(err, rank) {
					db.getObject('notifications:' + nid, function(err, notification) {
						notification.read = rank !== null ? true:false;
						
						// Backwards compatibility for old notification schema
						if (notification.hasOwnProperty('text')) {
							notification.bodyShort = notification.text;
							notification.bodyLong = '';
							notification.text = validator.escape(notification.text);
						}

						notification.bodyShort = validator.escape(notification.bodyShort);
						notification.bodyLong = validator.escape(notification.bodyLong);

						if (notification.from && !notification.image) {
							User.getUserField(notification.from, 'picture', function(err, picture) {
								notification.image = picture;
								callback(notification);
							});
						} else if (notification.image) {
							switch(notification.image) {
								case 'brand:logo':
									notification.image = meta.config['brand:logo'] || nconf.get('relative_path') + '/logo.png';
								break;
							}

							callback(notification);
						} else {
							callback(notification);
						}
					});
				});
			} else {
				// Remove from the user's boxes
				if (process.env.NODE_ENV === 'development') {
					winston.info('[notifications.get] nid ' + nid + ' not found. Removing.');
				}

				async.parallel([
					function(next) {
						db.sortedSetRemove('uid:' + uid + ':notifications:unread', nid, next);
					},
					function(next) {
						db.sortedSetRemove('uid:' + uid + ':notifications:read', nid, next);
					}
				], function(err) {
					callback(null);
				});
			}
		});
	};

	Notifications.create = function(data, callback) {
		/**
		*data.uniqueId is used solely to override stale nids.
		*		If a new nid is pushed to a user and an existing nid in the user's
		*		(un)read list contains the same uniqueId, it will be removed, and
		*		the new one put in its place.
		*/

		// Add default values to data Object if not already set
		var	defaults = {
				bodyShort: '',
				bodyLong: '',
				path: '',
				importance: 5,
				datetime: Date.now(),
				uniqueId: utils.generateUUID()
			};

		for(var v in defaults) {
			if (defaults.hasOwnProperty(v) && !data[v]) {
				data[v] = defaults[v];
			}
		}

		// Backwards compatibility for old notification schema
		// Remove this block for NodeBB v0.6.0
		if (data.hasOwnProperty('text')) {
			data.bodyShort = data.text;
			data.bodyLong = '';
			delete data.text;
		}

		db.incrObjectField('global', 'nextNid', function(err, nid) {
			data.nid = nid;
			db.setAdd('notifications', nid);
			db.setObject('notifications:' + nid, data, function(err, status) {
				if (!err) {
					callback(nid);
				} else {
					winston.error('[notifications.create] ' + err.message);
				}
			});
		});
	};

	Notifications.push = function(nid, uids, callback) {
		var websockets = require('./socket.io');
		if (!Array.isArray(uids)) {
			uids = [uids];
		}

		var numUids = uids.length,
			x;

		Notifications.get(nid, null, function(notif_data) {
			async.each(uids, function(uid, next) {
				if (!parseInt(uid, 10)) {
					return next();
				}

				checkReplace(notif_data.uniqueId, uid, notif_data, function(err, replace) {
					if (replace) {
						db.sortedSetAdd('uid:' + uid + ':notifications:unread', notif_data.datetime, nid);

						// Client-side
						websockets.in('uid_' + uid).emit('event:new_notification', notif_data);

						// Plugins
						notif_data.uid = uid;
						plugins.fireHook('action:notification.pushed', notif_data);
					}
					next();
				});

			}, function(err) {
				if (callback) {
					callback(null, true);
				}
			});
		});
	};

	Notifications.pushGroup = function(nid, groupName, callback) {
		if (!callback) {
			callback = function() {};
		}

		groups.get(groupName, {}, function(err, groupObj) {
			if (!err && groupObj) {
				if (groupObj.memberCount > 0) {
					Notifications.push(nid, groupObj.members, callback);
				}
			} else {
				callback(err);
			}
		});
	};

	function checkReplace(uniqueId, uid, newNotifObj, callback) {
		var	replace = false, matched = false;

		function checkAndRemove(set, next) {
			db.getSortedSetRange(set, 0, -1, function(err, nids) {
				if (err || !nids || !nids.length) {
					return next(err);
				}

				var keys = nids.map(function(nid) {
					return 'notifications:' + nid;
				});

				db.getObjectsFields(keys, ['nid', 'uniqueId', 'importance'], function(err, nid_infos) {
					if (err) {
						return next(err);
					}

					nid_infos.forEach(function(nid_info) {
						if (nid_info && nid_info.uniqueId === uniqueId) {
							matched = true;
							if ((nid_info.importance || 5) >= newNotifObj.importance) {
								replace = true;
								db.sortedSetRemove(set, nid_info.nid);
							}
						}

					});

					next();
				});
			});
		}

		async.parallel([
			function(next) {
				checkAndRemove('uid:' + uid + ':notifications:unread', next);
			},
			function(next) {
				checkAndRemove('uid:' + uid + ':notifications:read', next);
			}
		], function(err) {
			if (!err) {
				if (replace === false && matched === false) {
					replace = true;
				}

				callback(null, replace);
			}
		});
	}

	Notifications.mark_read = function(nid, uid, callback) {
		callback = callback || function() {};
		if (!parseInt(uid, 10)) {
			return callback();
		}

		Notifications.get(nid, uid, function(notif_data) {
			async.parallel([
				function(next) {
					db.sortedSetRemove('uid:' + uid + ':notifications:unread', nid, next);
				},
				function(next) {
					if (!notif_data) {
						return next();
					}
					db.sortedSetAdd('uid:' + uid + ':notifications:read', notif_data.datetime, nid, next);
				}
			], callback);
		});
	};

	Notifications.mark_read_multiple = function(nids, uid, callback) {
		if (!Array.isArray(nids) && parseInt(nids, 10) > 0) {
			nids = [nids];
		}

		async.each(nids, function(nid, next) {
			Notifications.mark_read(nid, uid, function(err) {
				if (!err) {
					next(null);
				}
			});
		}, function(err) {
			if (callback) {
				callback(err);
			}
		});
	};

	Notifications.mark_all_read = function(uid, callback) {
		db.getSortedSetRange('uid:' + uid + ':notifications:unread', 0, 10, function(err, nids) {
			if (err) {
				return callback(err);
			}

			if (nids.length > 0) {
				Notifications.mark_read_multiple(nids, uid, function(err) {
					callback(err);
				});
			} else {
				callback();
			}
		});
	};

	Notifications.prune = function(cutoff) {
		var start = process.hrtime();

		if (process.env.NODE_ENV === 'development') {
			winston.info('[notifications.prune] Removing expired notifications from the database.');
		}

		var	today = new Date(),
			numPruned = 0;

		if (!cutoff) {
			cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 7);
		}

		var	cutoffTime = cutoff.getTime();

		db.getSetMembers('notifications', function(err, nids) {
			async.filter(nids, function(nid, next) {
				db.getObjectField('notifications:' + nid, 'datetime', function(err, datetime) {
					if (parseInt(datetime, 10) < cutoffTime) {
						next(true);
					} else {
						next(false);
					}
				});
			}, function(expiredNids) {
				async.each(expiredNids, function(nid, next) {
					async.parallel([
						function(next) {
							db.setRemove('notifications', nid, next);
						},
						function(next) {
							db.delete('notifications:' + nid, next);
						}
					], function(err) {
						numPruned++;
						next(err);
					});
				}, function(err) {
					if (!err) {
						if (process.env.NODE_ENV === 'development') {
							winston.info('[notifications.prune] Notification pruning completed. ' + numPruned + ' expired notification' + (numPruned !== 1 ? 's' : '') + ' removed.');
						}
						var diff = process.hrtime(start);
						events.log('Pruning notifications took : ' + (diff[0] * 1e3 + diff[1] / 1e6) + ' ms');
					} else {
						winston.error('Encountered error pruning notifications: ' + err.message);
					}
				});
			});
		});
	};

}(exports));

