'use strict';


/* globals define, app, templates, translator, socket, bootbox, config, ajaxify, RELATIVE_PATH, utils */

define('forum/topic', ['forum/pagination', 'forum/infinitescroll', 'forum/topic/threadTools', 'forum/topic/postTools', 'forum/topic/events', 'navigator'], function(pagination, infinitescroll, threadTools, postTools, events, navigator) {
	var	Topic = {},
		scrollingToPost = false,
		currentUrl = '';


	$(window).on('action:ajaxify.start', function(ev, data) {
		if(data.url.indexOf('topic') !== 0) {
			navigator.hide();
			$('.header-topic-title').find('span').text('').hide();
			app.removeAlert('bookmark');

			events.removeListeners();

			socket.removeListener('event:new_post', onNewPost);
		}
	});

	Topic.init = function() {
		var tid = ajaxify.variables.get('topic_id'),
			thread_state = {
				locked: ajaxify.variables.get('locked'),
				deleted: ajaxify.variables.get('deleted'),
				pinned: ajaxify.variables.get('pinned')
			},
			postCount = ajaxify.variables.get('postcount');

		$(window).trigger('action:topic.loading');

		app.enterRoom('topic_' + tid);

		showBottomPostBar();

		postTools.init(tid, thread_state);
		threadTools.init(tid, thread_state);
		events.init();

		handleSorting();

		hidePostToolsForDeletedPosts();

		enableInfiniteLoadingOrPagination();

		addBlockquoteEllipses($('.topic .post-content > blockquote'));

		var bookmark = localStorage.getItem('topic:' + tid + ':bookmark');
		var postIndex = getPostIndex();
		if (postIndex) {
			Topic.scrollToPost(postIndex - 1, true);
		} else if (bookmark && (!config.usePagination || (config.usePagination && pagination.currentPage === 1)) && postCount > 1) {
			app.alert({
				alert_id: 'bookmark',
				message: '[[topic:bookmark_instructions]]',
				timeout: 0,
				type: 'info',
				clickfn : function() {
					Topic.scrollToPost(parseInt(bookmark, 10), true);
				},
				closefn : function() {
					localStorage.removeItem('topic:' + tid + ':bookmark');
				}
			});
		}

		navigator.init('.posts > .post-row', postCount, Topic.navigatorCallback);

		socket.on('event:new_post', onNewPost);

		$(window).on('scroll', updateTopicTitle);

		$(window).trigger('action:topic.loaded');

		socket.emit('topics.markAsRead', tid);
		socket.emit('topics.increaseViewCount', tid);
	};

	function handleSorting() {
		var threadSort = $('.thread-sort');
		threadSort.find('i').removeClass('fa-check');
		var currentSetting = threadSort.find('a[data-sort="' + config.topicPostSort + '"]');
		currentSetting.find('i').addClass('fa-check');

		$('.thread-sort').on('click', 'a', function() {
			var newSetting = $(this).attr('data-sort');
			socket.emit('user.setTopicSort', newSetting, function(err) {
				config.topicPostSort = newSetting;
				ajaxify.go('topic/' + ajaxify.variables.get('topic_slug'));
			});
		});
	}

	function getPostIndex() {
		var parts = window.location.pathname.split('/');
		return parts[4] ? parseInt(parts[4], 10) : 0;
	}

	function showBottomPostBar() {
		if($('#post-container .post-row').length > 1 || !$('#post-container li[data-index="0"]').length) {
			$('.bottom-post-bar').removeClass('hide');
		}
	}

	function onNewPost(data) {
		var tid = ajaxify.variables.get('topic_id');
		if(data && data.posts && data.posts.length && data.posts[0].tid !== tid) {
			return;
		}

		if(config.usePagination) {
			return onNewPostPagination(data);
		}

		for (var i=0; i<data.posts.length; ++i) {
			var postcount = $('.user_postcount_' + data.posts[i].uid);
			postcount.html(parseInt(postcount.html(), 10) + 1);
		}

		socket.emit('topics.markAsRead', tid);
		createNewPosts(data);
	}

	function addBlockquoteEllipses(blockquotes) {
		blockquotes.each(function() {
			var $this = $(this);
			if ($this.find(':hidden').length && !$this.find('.toggle').length) {
				$this.append('<i class="fa fa-ellipsis-h pointer toggle"></i>');
			}
		});

		$('blockquote .toggle').on('click', function() {
			$(this).parent('blockquote').toggleClass('uncollapsed');
		});
	}

	function enableInfiniteLoadingOrPagination() {
		if(!config.usePagination) {
			infinitescroll.init(loadMorePosts, $('#post-container .post-row[data-index="0"]').height());
		} else {
			navigator.hide();

			pagination.init(parseInt(ajaxify.variables.get('currentPage'), 10), parseInt(ajaxify.variables.get('pageCount'), 10));
		}
	}

	function hidePostToolsForDeletedPosts() {
		$('#post-container li.deleted').each(function() {
			postTools.toggle($(this).attr('data-pid'), true);
		});
	}


	function updateTopicTitle() {
		if($(window).scrollTop() > 50) {
			$('.header-topic-title').find('span').text(ajaxify.variables.get('topic_name')).show();
		} else {
			$('.header-topic-title').find('span').text('').hide();
		}
	}

	Topic.navigatorCallback = function(element) {
		var postIndex = parseInt(element.attr('data-index'), 10);

		var currentBookmark = localStorage.getItem('topic:' + ajaxify.variables.get('topic_id') + ':bookmark');

		if (!currentBookmark || parseInt(postIndex, 10) >= parseInt(currentBookmark, 10)) {
			localStorage.setItem('topic:' + ajaxify.variables.get('topic_id') + ':bookmark', postIndex);
			app.removeAlert('bookmark');
		}

		if (!scrollingToPost) {
			var parts = ajaxify.removeRelativePath(window.location.pathname.slice(1)).split('/');
			var topicId = parts[1],
				slug = parts[2];
			var newUrl = 'topic/' + topicId + '/' + (slug ? slug : '');
			if (postIndex > 0) {
				 newUrl += '/' + (postIndex + 1);
			}

			if (newUrl !== currentUrl) {
				if (history.replaceState) {
					var search = (window.location.search ? window.location.search : '');
					history.replaceState({
						url: newUrl + search
					}, null, window.location.protocol + '//' + window.location.host + RELATIVE_PATH + '/' + newUrl + search);
				}
				currentUrl = newUrl;
			}
		}
	};

	Topic.scrollToPost = function(postIndex, highlight, duration, offset) {
		if (!utils.isNumber(postIndex)) {
			return;
		}

		if (!offset) {
			offset = 0;
		}

		scrollingToPost = true;

		if($('#post_anchor_' + postIndex).length) {
			return scrollToPid(postIndex);
		}

		if(config.usePagination) {
			if (window.location.search.indexOf('page') !== -1) {
				navigator.update();
				scrollingToPost = false;
				return;
			}

			var page = Math.ceil((postIndex + 1) / config.postsPerPage)

			if(parseInt(page, 10) !== pagination.currentPage) {
				pagination.loadPage(page, function() {
					scrollToPid(postIndex);
				});
			} else {
				scrollToPid(postIndex);
			}
		} else {
			$('#post-container').empty();
			var after = postIndex - config.postsPerPage + 1;
			if(after < 0) {
				after = 0;
			}
			loadPostsAfter(after, function() {
				scrollToPid(postIndex);
			});
		}

		function scrollToPid(postIndex) {
			var scrollTo = $('#post_anchor_' + postIndex),
				tid = $('#post-container').attr('data-tid');

			function animateScroll() {
				$('html, body').animate({
					scrollTop: (scrollTo.offset().top - $('#header-menu').height() - offset) + 'px'
				}, duration !== undefined ? duration : 400, function() {
					scrollingToPost = false;
					navigator.update();
					highlightPost();
					$('body').scrollTop($('body').scrollTop() - 1);
					$('html').scrollTop($('html').scrollTop() - 1);
				});
			}

			function highlightPost() {
				if (highlight) {
					scrollTo.parent().find('.topic-item').addClass('highlight');
					setTimeout(function() {
						scrollTo.parent().find('.topic-item').removeClass('highlight');
					}, 5000);
				}
			}

			if (tid && scrollTo.length) {
				if($('#post-container li.post-row[data-index="' + postIndex + '"]').attr('data-index') !== '0') {
					animateScroll();
				} else {
					navigator.update();
					highlightPost();
				}
			}
		}
	};

	function onNewPostPagination(data) {
		var posts = data.posts;
		socket.emit('topics.getPageCount', ajaxify.variables.get('topic_id'), function(err, newPageCount) {

			pagination.recreatePaginationLinks(newPageCount);

			if (pagination.currentPage === pagination.pageCount) {
				createNewPosts(data);
			} else if(data.posts && data.posts.length && parseInt(data.posts[0].uid, 10) === parseInt(app.uid, 10)) {
				pagination.loadPage(pagination.pageCount);
			}
		});
	}

	function createNewPosts(data, callback) {
		if(!data || (data.posts && !data.posts.length)) {
			return;
		}

		function removeAlreadyAddedPosts() {
			data.posts = data.posts.filter(function(post) {
				return $('#post-container li[data-pid="' + post.pid +'"]').length === 0;
			});
		}

		var after = null,
			before = null;

		function findInsertionPoint() {
			var firstPostTimestamp = parseInt(data.posts[0].timestamp, 10);
			var firstPostVotes = parseInt(data.posts[0].votes, 10);
			var firstPostPid = data.posts[0].pid;

			var firstReply = $('#post-container li.post-row[data-index!="0"]').first();
			var lastReply = $('#post-container li.post-row[data-index!="0"]').last();

			if (config.topicPostSort === 'oldest_to_newest') {
				if (firstPostTimestamp < parseInt(firstReply.attr('data-timestamp'), 10)) {
					before = firstReply;
				} else if(firstPostTimestamp >= parseInt(lastReply.attr('data-timestamp'), 10)) {
					after = lastReply;
				}
			} else if(config.topicPostSort === 'newest_to_oldest') {
				if (firstPostTimestamp > parseInt(firstReply.attr('data-timestamp'), 10)) {
					before = firstReply;
				} else if(firstPostTimestamp <= parseInt(lastReply.attr('data-timestamp'), 10)) {
					after = lastReply;
				}
			} else if(config.topicPostSort === 'most_votes') {
				if (firstPostVotes > parseInt(firstReply.attr('data-votes'), 10)) {
					before = firstReply;
				} else if(firstPostVotes < parseInt(firstReply.attr('data-votes'), 10)) {
					after = lastReply;
				} else {
					if (firstPostPid > firstReply.attr('data-pid')) {
						before = firstReply;
					} else if(firstPostPid <= firstReply.attr('data-pid')) {
						after = lastReply;
					}
				}
			}
		}

		removeAlreadyAddedPosts();
		if(!data.posts.length) {
			return;
		}

		findInsertionPoint();

		data.title = $('<div></div>').text(ajaxify.variables.get('topic_name')).html();
		data.viewcount = ajaxify.variables.get('viewcount');

		infinitescroll.parseAndTranslate('topic', 'posts', data, function(html) {
			if(after) {
				html.insertAfter(after);
			} else if(before) {
				html.insertBefore(before);
			} else {
				$('#post-container').append(html);
			}

			html.hide().fadeIn('slow');

			addBlockquoteEllipses(html.find('.post-content > blockquote'));

			onNewPostsLoaded(html, data.posts);
			if (typeof callback === 'function') {
				callback();
			}
		});
	}

	function onNewPostsLoaded(html, posts) {
		function getPostPrivileges(pid) {
			socket.emit('posts.getPrivileges', pid, function(err, privileges) {
				if(err) {
					return app.alertError(err.message);
				}
				toggleModTools(html, privileges);
			});
		}

		for (var x = 0, numPosts = posts.length; x < numPosts; x++) {
			getPostPrivileges(posts[x].pid);
		}

		app.populateOnlineUsers();
		app.createUserTooltips();
		utils.addCommasToNumbers(html.find('.formatted-number'));
		utils.makeNumbersHumanReadable(html.find('.human-readable-number'));
		html.find('span.timeago').timeago();
		html.find('.post-content img').addClass('img-responsive');
		postTools.updatePostCount();
		showBottomPostBar();
	}

	function toggleModTools(postHtml, privileges) {
		postHtml.find('.edit, .delete').toggleClass('none', !privileges.editable);
		postHtml.find('.move').toggleClass('none', !privileges.move);
		postHtml.find('.reply, .quote').toggleClass('none', !$('.post_reply').length);
		var isSelfPost = parseInt(postHtml.attr('data-uid'), 10) === parseInt(app.uid, 10);
		postHtml.find('.chat, .flag').toggleClass('none', isSelfPost);
	}

	function loadMorePosts(direction) {
		if (!$('#post-container').length || scrollingToPost) {
			return;
		}

		infinitescroll.calculateAfter(direction, '#post-container .post-row[data-index!="0"]', config.postsPerPage, function(after, offset, el) {
			loadPostsAfter(after, function() {
				if (direction < 0 && el) {
					Topic.scrollToPost(el.attr('data-index'), false, 0, offset);
				}
			});
		});
	}

	function loadPostsAfter(after, callback) {
		var tid = ajaxify.variables.get('topic_id');
		if (!utils.isNumber(tid) || !utils.isNumber(after) || (after === 0 && $('#post-container li.post-row[data-index="1"]').length)) {
			return;
		}

		var indicatorEl = $('.loading-indicator');
		if (!indicatorEl.is(':animated')) {
			indicatorEl.fadeIn();
		}

		infinitescroll.loadMore('topics.loadMore', {
			tid: tid,
			after: after
		}, function (data, done) {

			indicatorEl.fadeOut();

			if (data && data.posts && data.posts.length) {
				createNewPosts(data, function() {
					done();
					callback();
				});
				hidePostToolsForDeletedPosts();
			} else {
				navigator.update();
				done();
			}
		});
	}

	return Topic;
});
