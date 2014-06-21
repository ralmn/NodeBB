'use strict';

var winston = require('winston'),
	async = require('async'),
	nconf = require('nconf'),
	validator = require('validator'),

	db = require('./database'),
	posts = require('./posts'),
	topics = require('./topics'),
	threadTools = require('./threadTools'),
	privileges = require('./privileges'),
	user = require('./user'),
	utils = require('../public/src/utils'),
	plugins = require('./plugins'),
	events = require('./events'),
	meta = require('./meta');

(function(PostTools) {

	PostTools.isMain = function(pid, tid, callback) {
		topics.getTopicField(tid, 'mainPid', function(err, mainPid) {
			callback(err, parseInt(pid, 10) === parseInt(mainPid, 10));
		});
	};

	PostTools.edit = function(uid, pid, title, content, options, callback) {
		options = options || {};

		function success(postData) {
			posts.setPostFields(pid, {
				edited: Date.now(),
				editor: uid,
				content: postData.content
			});

			events.logPostEdit(uid, pid);

			async.parallel({
				topic: function(next) {
					var tid = postData.tid;
					PostTools.isMain(pid, tid, function(err, isMainPost) {
						if (err) {
							return next(err);
						}

						if (isMainPost) {
							title = title.trim();
							var slug = tid + '/' + utils.slugify(title);

							topics.setTopicField(tid, 'title', title);
							topics.setTopicField(tid, 'slug', slug);

							topics.setTopicField(tid, 'thumb', options.topic_thumb);

							topics.updateTags(tid, options.tags);

							plugins.fireHook('action:topic.edit', tid);
						}

						plugins.fireHook('action:post.edit', postData);

						next(null, {
							tid: tid,
							title: validator.escape(title),
							isMainPost: isMainPost
						});
					});

				},
				content: function(next) {
					PostTools.parse(postData.content, next);
				}
			}, callback);
		}

		privileges.posts.canEdit(pid, uid, function(err, canEdit) {
			if (err || !canEdit) {
				return callback(err || new Error('[[error:no-privileges]]'));
			}

			posts.getPostData(pid, function(err, postData) {
				if (err) {
					return callback(err);
				}

				postData.content = content;
				plugins.fireHook('filter:post.save', postData, function(err, postData) {
					if (err) {
						return callback(err);
					}

					success(postData);
				});
			});
		});
	};

	PostTools.delete = function(uid, pid, callback) {
		togglePostDelete(uid, pid, true, callback);
	};

	PostTools.restore = function(uid, pid, callback) {
		togglePostDelete(uid, pid, false, callback);
	};

	function togglePostDelete(uid, pid, isDelete, callback) {
		async.waterfall([
			function(next) {
				posts.getPostField(pid, 'deleted', next);
			},
			function(deleted, next) {
				if(parseInt(deleted, 10) === 1 && isDelete) {
					return next(new Error('[[error:post-already-deleted]]'));
				} else if(parseInt(deleted, 10) !== 1 && !isDelete) {
					return next(new Error('[[error:post-already-restored]]'));
				}

				privileges.posts.canEdit(pid, uid, next);
			},
			function(canEdit, next) {
				if (!canEdit) {
					return next(new Error('[[error:no-privileges]]'));
				}
				next();
			}
		], function(err) {
			if(err) {
				return callback(err);
			}

			posts.setPostField(pid, 'deleted', isDelete ? 1 : 0, function(err) {
				if (err) {
					return callback(err);
				}

				events[isDelete ? 'logPostDelete' : 'logPostRestore'](uid, pid);

				db.incrObjectFieldBy('global', 'postCount', isDelete ? -1 : 1);

				posts.getPostFields(pid, ['pid', 'tid', 'uid', 'content', 'timestamp'], function(err, postData) {
					if (err) {
						return callback(err);
					}

					if (isDelete) {
						plugins.fireHook('action:post.delete', pid);
					} else {
						plugins.fireHook('action:post.restore', postData);
					}

					async.parallel([
						function(next) {
							topics[isDelete ? 'decreasePostCount' : 'increasePostCount'](postData.tid, next);
						},
						function(next) {
							user.incrementUserPostCountBy(postData.uid, isDelete ? -1 : 1, next);
						},
						function(next) {
							updateTopicTimestamp(postData.tid, next);
						},
						function(next) {
							addOrRemoveFromCategory(pid, postData.tid, postData.timestamp, isDelete, next);
						}
					], function(err) {
						if (!isDelete) {
							PostTools.parse(postData.content, function(err, parsed) {
								postData.content = parsed;
								callback(err, postData);
							});
							return;
						}
						callback(err, postData);
					});
				});
			});
		});
	}

	PostTools.purge = function(uid, pid, callback) {
		privileges.posts.canEdit(pid, uid, function(err, canEdit) {
			if (err || !canEdit) {
				return callback(err || new Error('[[error:no-privileges]]'));
			}

			posts.purge(pid, callback);
		});
	};

	function updateTopicTimestamp(tid, callback) {
		topics.getLatestUndeletedPid(tid, function(err, pid) {
			if(err || !pid) {
				return callback(err);
			}

			posts.getPostField(pid, 'timestamp', function(err, timestamp) {
				if (err) {
					return callback(err);
				}

				if (timestamp) {
					topics.updateTimestamp(tid, timestamp);
				}
				callback();
			});
		});
	}

	function addOrRemoveFromCategory(pid, tid, timestamp, isDelete, callback) {
		topics.getTopicField(tid, 'cid', function(err, cid) {
			if (err) {
				return callback(err);
			}

			db.incrObjectFieldBy('category:' + cid, 'post_count', isDelete ? -1 : 1);

			if (isDelete) {
				db.sortedSetRemove('categories:recent_posts:cid:' + cid, pid, callback);
			} else {
				db.sortedSetAdd('categories:recent_posts:cid:' + cid, timestamp, pid, callback);
			}
		});
	}

	PostTools.parse = function(raw, callback) {
		parse('filter:post.parse', raw, callback);
	};

	PostTools.parseSignature = function(raw, callback) {
		parse('filter:post.parseSignature', raw, callback);
	};

	function parse(hook, raw, callback) {
		raw = raw || '';

		plugins.fireHook(hook, raw, function(err, parsed) {
			callback(null, !err ? parsed : raw);
		});
	}

}(exports));
