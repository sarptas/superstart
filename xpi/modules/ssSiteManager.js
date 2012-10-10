/**
 * events:
 * 	sites-loaded
 *	sites-added
 *	site-removed
 *	site-simple-move
 *	site-changed
 *	site-snapshot-changed
 */
var EXPORTED_SYMBOLS = [ "ssSiteManager" ];

function ssSiteManager() {

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cr = Components.results;
const Cu = Components.utils;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/NetUtil.jsm");
Cu.import("resource://gre/modules/FileUtils.jsm");

	let that = this;

	// utilities
	function log(s) {
		that.logger.logStringMessage(s);
	}

	function SHA1 (msg) {
		function tohex(s) {
			let hc = '0123456789ABCDEF';
			let he = new Array(s.length * 2);
			for (let i = 0, j = s.length; i < j; ++ i) {
				let c = s.charCodeAt(i);
				he[i * 2] = hc.charAt((c >> 4) & 15);
				he[i * 2 + 1] = hc.charAt(c & 15);
			}
			return he.join('');
		}

		let h = Cc["@mozilla.org/security/hash;1"].createInstance(Ci.nsICryptoHash);
		h.init(Ci.nsICryptoHash.SHA1);
		let s = Cc['@mozilla.org/io/string-input-stream;1'].createInstance(Ci.nsIStringInputStream);
		s.setData(msg, msg.length);
		h.updateFromStream(s, s.available());
		let m = h.finish(false);
		s = h = null;

		return tohex(m);
	}

	////////////////////
	// load / save
	let /* nsIFile */ file = FileUtils.getFile('ProfD', ['superstart', 'sites.json']);
	let imgWidth = 256;
	let ratio = 0.625;
	let imgHeight = Math.floor(imgWidth * ratio);

	let imgLoading = 'images/loading.gif';
	let imgNoSnapshot = 'images/no-image.png';
	let favIcon = 'chrome://mozapps/skin/places/defaultFavicon.png';

	let inLoading = false;
	let data = null; // see doc/data.txt for details

	// fn is a function and should return **true** to stop the travelling
	function travel(fn) {
		for (let i = 0, l = data.sites.length; i < l; ++ i) {
			let s = data.sites[i];
			if (s.sites && Array.isArray(s.sites)) {
				let j = 0, k = s.sites.length;
				if (k == 0) {
					log('siteManager::travel get error data at index ' + i);
				}
				for (; j < k; ++ j) {
					if (fn(s.sites[j], [i, j])) {
						return;
					}
				}
			} else {
				if (fn(s, [-1, i])) {
					return;
				}
			}
		}
	}

	function create() {
		data = {
			'version' : "1.0",
			'sites' : []
		};
		save();
		that.fireEvent('sites-loaded', null);
	}

	function check() {
		let changed = false;
		let sites = data.sites;
		try {
			// check for empty 
			for (let i = 0; i < sites.length; ++ i) {
				let s = sites[i];
				// folder
				if (s.sites) {
					if (!Array.isArray(s.sites) || s.sites.length == 0) {
						delete s.sites;
						-- i; // check it as an URL in the next round
						changed = true;
					} else {
						for (let j = 0; j < s.sites.length; ++ j) {
							if (s.sites[j].url == null) {
								s.sites.splice(j, 1);
								changed = true;
							}
						}

						if (s.sites.length == 1) {
							sites[i] = s.sites[0];
							changed = true;
						} else if (s.sites.length == 0) {
							sites.splice(i, 1);
							-- i;
							changed = true;
						}
					}
				} else {
					if (s.url == null) {
						sites.splice(i, 1);
						-- i;
						changed = true;
					}
				}
			}
		} catch (e) {
			log('siteManager::check() ' + e);
			create();
			return true;
		}

		// check snapshots
		travel(function(s) {
			if (s.snapshots[0] == imgLoading || s.snapshots[1] == imgLoading) {
				s.snapshots[0] = s.snapshots[1] = imgNoSnapshot;
				changed = true;
			}
		});
		return changed;
	}

	function load() {
		inLoading = true;
		if (!file.exists()) {
			create();
		} else {
			try {
				let changed = false;
				data = that.jparse(that.fileGetContents(file));
				if (check()) {
					save();
				}
			} catch (e) {
				log('siteManager::load() ' + e);
				create();
			}
		}
		inLoading = false;
	}

	function save() {
		that.filePutContents(file, that.stringify(data));
	}

	function getLiveSnapshot(url) {
		return 'moz-page-thumb://thumbnail?url=' + encodeURIComponent(url);
	}

	function adjustSite(s) {
		if (s.sites != undefined && Array.isArray(s.sites)) {
			for (let i = 0; i < s.sites.length; ++ i) {
				adjustSite(s.sites[i]);
			}
			s.displayName = s.title || 'Group';
		} else {
			s.sites = undefined;
			for (let i = 0; i < 2; ++ i) {
				if (s.snapshots[i] != '') {
					let st = s.snapshots[i];
					if (st.indexOf('images/')) {
						s.snapshots[i] = that.regulateUrl(pathFromName(st)).replace(/\\/g, '/');
					}
				}
			}
			if (s.snapshots[3] != '') {
				s.snapshots[3] = that.regulateUrl(s.snapshots[3]).replace(/\\/g, '/');
			}
			s.displayName = s.name || (s.title || s.url);
		}
		return s;
	}

	function getSite(group, idx) {
		if ((group == -1 && (idx < 0 || idx >= data.sites.length)) || ((group < 0 && group != -1) || group >= data.sites.length)) {
			return null;
		} else {
			if (group == -1) {
				return data.sites[idx];
			} else {
				let g = data.sites[group];
				if (g.sites == null || !Array.isArray(g.sites) || (idx < 0 || idx >= g.sites.length)) {
					return null;
				}
				return g.sites[idx];
			}
		}
	}

	function updateSiteInformation(idxes, url, title, name, icon, shotNames, custImg, snapshotIndex) {
		if (Array.isArray(idxes) && idxes.length == 2) {
			let s = getSite(idxes[0], idxes[1]);
			if (s != null && Array.isArray(shotNames) && shotNames.length == 2) {
				s.url = url;
				s.title = title;
				s.name = name;
				s.icon = icon;
				s.snapshots[0] = shotNames[0];
				s.snapshots[1] = shotNames[1];
				s.snapshots[3] = custImg;
				s.snapshotIndex = snapshotIndex;

				save();
				that.fireEvent('site-changed', [idxes[0], idxes[1]]);
			} else {
				log('----- Update site information with: ' + idxes[0] + ' : ' + idxes[1] + ' failed -----');
			}
		}
	}

	function removeSiteInGroup(g, i) {
		if (g == -1) {
			log('removeSiteInGroup cannot remove top site');
			return null;
		}
		var sites = data.sites;
		var f = getSite(-1, g);
		var s = getSite(g, i);
		if (f == null || s == null) {
			log('removeSite(' + g + ', ' + i + ') is not available');
			return;
		}
		f.sites.splice(i, 1);
		if (f.sites.length == 1) {
			sites[g] = f.sites[0];
		}
		return s;
	}

	////////////////////
	// methods
	this.getTopSiteCount = function() {
		return data.sites.length;
	}

	this.getSites = function() {
		let sites = that.jparse(that.stringify(data.sites));
		for (let i = 0, l = sites.length; i < l; ++ i) {
			adjustSite(sites[i]);
		}
		return sites;
	}

	this.getSite = function(group, idx) {
		let s = getSite(group, idx);
		if (s != null) {
			s = that.jparse(that.stringify(s));
			adjustSite(s);
		}
		return s;
	}

	this.addSite = function(url, name, image) {
		url = this.regulateUrl(url);
		let living = getLiveSnapshot(url);
		let s = {
			'url': url,
			'title': url,
			'name': name,
			'snapshots': [imgLoading, imgLoading, living, image],
			'snapshotIndex': (image == '' ? 0 : 2)
		};
		data.sites.push(s);
		save();
		this.fireEvent('site-added', data.sites.length - 1);
		takeSnapshot(url); // TODO: if the url already exists, why not use the existed screenshots instead?
	}

	this.removeSite = function(group, idx) {
		let s = getSite(group, idx);
		if (s != null) {
			if (group == -1) {
				data.sites.splice(idx, 1);
			} else {
				s = removeSiteInGroup(group, idx);
				if (s === null) {
					log('Remove site(' + group + ', ' + idx + ') failed');
					return;
				}
			}

			let found = false;
			let snapshot = s.snapshots[0];
			travel(function(s, idxes) {
				if (s.snapshots[0] == snapshot) {
					found = true;
					return true;
				}
			});
			if (!found) {
				removeSnapshots([s.snapshots[0], s.snapshots[1]]);
			}

			save();
			this.fireEvent('site-removed', [group, idx]);
		}
	}

	this.simpleMove = function(group, from, to) {
		var sites = data.sites;
		if (group != -1) {
			if (group < 0 || group >= sites.length || !Array.isArray(sites[group].sites)) {
				return;
			}
			sites = sites[group].sites;
		}

		if (from == to || from < 0 || from >= sites.length || to < 0 || to >= sites.length) {
			return;
		}

		// log('simple move, from ' + from + ' to ' + to);
		var s = sites.splice(from, 1)[0];
		if (to == sites.length) {
			sites.push(s);
		} else {
			sites.splice(to, 0, s);
		}

		save();
		this.fireEvent('site-simple-move', [group, from, to]);
	}

	this.moveIn = function(from, to) {
		var sites = data.sites;
		if (from < 0 || from >= sites.length || to < 0 || to >= sites.length || from == to) {
			return;
		}

		var d = sites[to];
		if (d.sites == null || !Array.isArray(d.sites)) {
			sites[to] = {
				'title': 'Group',
				'sites': [d]
			};
			d = sites[to];
		}
		var s = sites.splice(from, 1)[0];
		d.sites.push(s);
		save();

		this.fireEvent('site-move-in', [from, to]);
	}

	this.moveOut = function(g, i) {
		var s = removeSiteInGroup(g, i);
		if (s !== null) {
			var sites = data.sites;
			sites.push(s);
			save();

			this.fireEvent('site-move-out', [g, i]);
		}
	}

	this.nextSnapshot = function(group, idx) {
		let s = getSite(group, idx);
		if (s != null) {
			let i = s.snapshotIndex;
			++ i;
			if (i > 3 || (i == 3 && s.snapshots[i] == '')) {
				i = 0;
			}
			if (i != s.snapshotIndex) {
				s.snapshotIndex = i;
				save();
				this.fireEvent('site-snapshot-changed', [group, idx]);
			}
		}
	}


	// snapshots
	function fileFromName(name) {
		return FileUtils.getFile('ProfD', ['superstart', 'snapshots', name]);
	}
	
	function pathFromName(name) {
		return fileFromName(name).path;
	}

	function removeSnapshots(names) {
		for (let i = 0, l = names.length; i < l; ++ i) {
			try {
				let name = names[i];
				if (name && name.indexOf('images/') != 0) {
					let f = fileFromName(name);
					f.remove(false);
				}
			} catch (e) {
				log('remove file: ' + names[i] + ' failed, exception is below:');
				log(e);
			}
		}
	}


	let takeSnapshot = (function() {
		let q = [];
		let max = 3;
		let taking = [];
		let browsers = {};

		function exists(url) {
			if (q.indexOf(url) != -1 || taking.indexOf(url) != -1) {
				return true;
			}
			return false;
		}

		function beginTaking() {
			if (taking.length >= max || q.length == 0) {
				return;
			}
			let url = q.shift();
			taking.push(url);

			let wm = Cc["@mozilla.org/appshell/window-mediator;1"].getService(Ci.nsIWindowMediator);
			let gw = wm.getMostRecentWindow("navigator:browser");

			let width = imgWidth, height = imgHeight;
			let fw = 1024, fh = Math.floor(fw * ratio);

			let gDoc = gw.document;
			let container = gDoc.getElementById('superstart-snapshot-container');
			let browser = gDoc.createElement('browser');
			browsers[url] = browser; // save it
			// set the browser attributes
			browser.width = fw;
			browser.height = fh;
			browser.setAttribute('type', 'content');
			browser.setAttribute('src', url);

			container.appendChild(browser);

			let now = (new Date()).getTime();
			let timeout = 30 * 1000;
			let timeoutId = gw.setTimeout(onTimeout, timeout);
			browser.addEventListener('load', onLoad, true);

			function onLoad() {
				gw.clearTimeout(timeoutId);
				timeout = ((new Date().getTime() - now) * 3); // wait more time for multimedia content to be loaded
				if (timeout < 1000) {
					timeout = 1000;
				} else if (timeout > 15 * 1000) {
					timeout = 15 * 1000;
				}
				timeoutId = gw.setTimeout(onTimeout, timeout);
			}

			function onTimeout() {
				let doc = browser.contentDocument;
				let title = doc.title || url;
				let icon = getIcon(doc);
				doc = null;

				let names = [SHA1(url + Math.random()) + '.png', SHA1(url + Math.random()) + '.png'];
				let pathes = [pathFromName(names[0]), pathFromName(names[1])];
				let canvases = window2canvas(gDoc, browser, width, height);
				saveCanvas(canvases[0], pathes[0], function() {
					saveCanvas(canvases[1], pathes[1], function() {
						let sites = data.sites;
						let used = false;
						travel(function(s, idxes) {
							if (s.url == url) {
								used = true;
								removeSnapshots([s.snapshots[0], s.snapshots[1]]);
								updateSiteInformation(idxes, url, title, s.name, icon, names, s.snapshots[3], s.snapshotIndex);
							}
						});
						if (!used) {
							removeSnapshots(names);
						}
	
						// clear resource
						delete browsers[url];
						browser.parentNode.removeChild(browser);
						browser = null;

						let i = taking.indexOf(url);
						if (i != -1) {
							taking.splice(i, 1);
						} else {
							log('takeSnapshot of ' + url + ' with error!');
						}
						if (q.length > 0) {
							beginTaking();
						}
					});
				});
			}
		}

		function getIcon(doc) {
			try {
				let loc = doc.location;
				if (loc.href.indexOf('http') == 0) {
					let links = doc.getElementsByTagName('link');
					// 1. look for rel="shortcut icon"
					for (let i = 0, l = links.length; i < l; ++ i) {
						let link = links[i];
						let rel = link.rel || '';
						if (rel.search(/icon/i) != -1 && rel.search(/shortcut/i) != -1) {
							return link.href;
						}
					}

					// 2. icon only
					for (let i = 0, l = links.length; i < l; ++ i) {
						let link = links[i];
						let rel = link.rel || '';
						if (rel.search(/icon/i) != -1) {
							return link.href;
						}
					}

					// 3. fallback
					if (loc.protocol == 'http:' || loc.protocol == 'https:') {
						return loc.protocol + '//' + loc.host + '/favicon.ico';
					}
				}
			} catch (e) {
				logger.logStringMessage(e);
			}
			return favIcon;
		}


		function window2canvas(gDoc, win) { // TODO: test for url: about:config
			let w = win.clientWidth;
			let h = win.clientHeight;
			try {
				w = win.contentDocument.body.clientWidth;
				h = Math.floor(w * ratio);
			} catch (e) {
			}
	
			let cs = [];
			for (let i = 0; i < 2; ++ i) {
				let c = gDoc.createElementNS("http://www.w3.org/1999/xhtml", "html:canvas");
				c.style.width = imgWidth + 'px';
				c.width = imgWidth;
				c.style.height = imgHeight + 'px';
				c.height = imgHeight;
	
				let ctx = c.getContext('2d');
				ctx.clearRect(0, 0, imgWidth, imgHeight);
				ctx.save();
				ctx.mozImageSmoothingEnabled = true;
				if (i == 0) {
					let aw = Math.floor(w / 3);
					let ah = Math.floor(aw * ratio);
					if (aw < imgWidth) {
						aw = imgWidth;
					}
					if (ah < imgHeight) {
						ah = imgHeight;
					}
					ctx.scale(imgWidth / aw, imgHeight / ah);
					ctx.drawWindow(win.contentWindow, 0, 0, aw, ah, "rgba(0,0,0,0)");
				} else {
					ctx.scale(imgWidth / w, imgHeight / h);
					ctx.drawWindow(win.contentWindow, 0, 0, w, h, "rgba(0,0,0,0)");
				}
				ctx.restore();

				cs.push(c);
			}
			return cs;
		}
	
		function saveCanvas(canvas, pathName, callback) {
			let file = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsILocalFile);
			file.initWithPath(pathName);
			let io = Cc['@mozilla.org/network/io-service;1'].getService(Ci.nsIIOService);
			let src = io.newURI(canvas.toDataURL('image/png', ''), 'UTF8', null);
			let persist = Cc['@mozilla.org/embedding/browser/nsWebBrowserPersist;1'].createInstance(Ci.nsIWebBrowserPersist);
			persist.persistFlags = Ci.nsIWebBrowserPersist.PERSIST_FLAGS_REPLACE_EXISTING_FILES;
			persist.persistFlags |= Ci.nsIWebBrowserPersist.PERSIST_FLAGS_AUTODETECT_APPLY_CONVERSION;
	
			let listener = {
				onStateChange: function(webProgress, req, flags, aStatus) {
					if (flags & Ci.nsIWebProgressListener.STATE_STOP) {
						persist.progressListener = null;
						persist = null;
						if (callback) {
							callback();
							callback = null;
						}
					}
				}
			}
			persist.progressListener = listener;
			persist.saveURI(src, null, null, null, null, file);
		}

		function takeSnapshot(url) {
			if (exists(url)) {
				return;
			}
			q.push(url);
			beginTaking();
		}

		return takeSnapshot;
	})();

	////////////////////
	// begin
	load();
}

