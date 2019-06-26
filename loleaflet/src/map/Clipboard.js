/* -*- js-indent-level: 8 -*- */
/*
 * L.Clipboard is used to abstract our storage and management of
 * local & remote clipboard data.
 */
/* global _ vex */

// Get all interesting clipboard related events here, and handle
// download logic in one place ...
// We keep track of the current selection content if it is simple
// So we can do synchronous copy/paste in the callback if possible.
L.Clipboard = L.Class.extend({
	initialize: function(map) {
		this._map = map;
		this._selectionContent = '';
		this._accessKey = [ '', '' ];
		this._clipboardSerial = 0; // incremented on each operation

		var that = this;
		document.addEventListener(
			'beforepaste', function(ev) { that.beforepaste(ev); });
	},

	stripHTML: function(html) { // grim.
		var tmp = document.createElement('div');
		tmp.innerHTML = html;
		return tmp.textContent || tmp.innerText || '';
	},

	setKey: function(key) {
		if (this._accessKey[0] === key)
			return;
		this._accessKey[1] = this._accessKey[0];
		this._accessKey[0] = key;
	},

	getMetaBase: function() {
		return this._map.options.webserver + this._map.options.serviceRoot;
	},

	getMetaPath: function(idx) {
		if (!idx)
			idx = 0;
		return '/clipboard?WOPISrc='+ encodeURIComponent(this._map.options.doc) +
			'&ServerId=' + this._map._socket.WSDServer.Id +
			'&ViewId=' + this._map._docLayer._viewId +
			'&Tag=' + this._accessKey[idx];
	},

	getStubHtml: function() {
		var lang = 'en_US'; // FIXME: l10n
		var encodedOrigin = encodeURIComponent(this.getMetaPath());
		return '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.0 Transitional//EN">\n' +
			'<html>\n' +
			'  <head>\n' +
			'     <meta http-equiv="content-type" content="text/html; charset=utf-8"/>\n' +
			'     <meta name="origin" content="' + encodedOrigin + '"/>\n' +
			'  </head>\n' +
			'  <body lang="' + lang + ' dir="ltr">\n' +
			'    <p>' + _('When pasting outside the suite it is necessary to first click the \'download\' button') + '</p>\n' +
			'  </body>\n' +
			'</html>';
	},

	_getMetaOrigin: function (html) {
		var match = '<meta name="origin" content="';
		var start = html.indexOf(match);
		if (start < 0) {
			return '';
		}
		var end = html.indexOf('"', start + match.length);
		if (end < 0) {
			return '';
		}
		var meta = html.substring(start + match.length, end);

		// quick sanity checks that it one of ours.
		if (meta.indexOf('%2Fclipboard%3FWOPISrc%3D') >= 0 &&
		    meta.indexOf('%26ServerId%3D') > 0 &&
		    meta.indexOf('%26ViewId%3D') > 0 &&
		    meta.indexOf('%26Tag%3D') > 0)
			return decodeURIComponent(meta);
		else
			console.log('Mis-understood foreign origin: "' + meta + '"');
		return '';
	},

	_encodeHtmlToBlob: function(data) {
		var content = [];
		content.push('text/html\n');
		content.push(data.length.toString(16) + '\n');
		content.push(data);
		content.push('\n');
		return new Blob(content);
	},

	_readContentSyncToBlob: function(dataTransfer) {
		var content = [];
		var types = dataTransfer.types;
		for (var t = 0; t < types.length; ++t) {
			var data = dataTransfer.getData(types[t]);
			content.push((types[t] == 'text' ? 'text/plain' : types[t]) + '\n');
			content.push(data.length.toString(16) + '\n');
			content.push(data);
			content.push('\n');
		}
		return new Blob(content);
	},

	// Abstract async post & download for our progress wrappers
	// type: GET or POST
	// url:  where to get / send the data
	// optionalFormData: used for POST for form data
	// completeFn: called on completion - with response.
	// progressFn: allows splitting the progress bar up.
	_doAsyncDownload: function(type,url,optionalFormData,completeFn,progressFn) {
		var that = this;
		var request = new XMLHttpRequest();

		that._startProgress();
		that._downloadProgress.startProgressMode();
		request.onload = function() {
			that._downloadProgress._onComplete();
			if (type == 'POST') {
				that._downloadProgress._onClose();
			}
			completeFn(this.response);
		}
		request.onerror = function() {
			that._downloadProgress._onComplete();
			that._downloadProgress._onClose();
		}

		request.upload.addEventListener('progress', function (e) {
			if (e.lengthComputable) {
				var percent = progressFn(e.loaded / e.total * 100);
				var progress = { statusType: 'setvalue', value: percent };
				that._downloadProgress._onUpdateProgress(progress);
			}
		}, false);
		request.open(type, url, true /* isAsync */);
		request.timeout = 20 * 1000; // 20 secs ...
		request.responseType = 'blob';
		if (optionalFormData !== null)
			request.send(optionalFormData);
		else
			request.send();
	},

	// Suck the data from one server to another asynchronously ...
	_dataTransferDownloadAndPasteAsync: function(src, dest) {
		var that = this;
		// FIXME: add a timestamp in the links (?) ignroe old / un-responsive servers (?)
		that._doAsyncDownload(
			'GET', src, null,
			function(response) {
				console.log('download done - response ' + response);
				var formData = new FormData();
				formData.append('data', response, 'clipboard');
				that._doAsyncDownload(
					'POST', dest, formData,
					function() {
						console.log('up-load done, now paste');
						that._map._socket.sendMessage('uno .uno:Paste')
					},
					function(progress) { return 50 + progress/2; }
				);
			},
			function(progress) { return progress/2; }
		);
	},

	// FIXME: do we want this really ?
	_onFileLoadFunc: function(file) {
		var socket = this._map._socket;
		return function(e) {
			var blob = new Blob(['paste mimetype=' + file.type + '\n', e.target.result]);
			socket.sendMessage(blob);
		};
	},

	dataTransferToDocument: function (dataTransfer, preferInternal, htmlText) {
		// Look for our HTML meta magic.
		//   cf. ClientSession.cpp /textselectioncontent:/

		var pasteHtml = null;
		if (dataTransfer == null) { // IE
			pasteHtml = htmlText;
		} else {
			pasteHtml = dataTransfer.getData('text/html');
		}
		var meta = this._getMetaOrigin(pasteHtml);
		var id = this.getMetaPath(0);
		var idOld = this.getMetaPath(1);

		// for the paste, we always prefer the internal LOK's copy/paste
		if (preferInternal === true &&
		    (meta.indexOf(id) >= 0 || meta.indexOf(idOld) >= 0))
		{
			// Home from home: short-circuit internally.
			console.log('short-circuit, internal paste');
			this._map._socket.sendMessage('uno .uno:Paste');
			return;
		}

		var destination = this.getMetaBase() + this.getMetaPath();

		// Do we have a remote Online we can suck rich data from ?
		if (meta !== '')
		{
			console.log('Transfer between servers\n\t"' + meta + '" vs. \n\t"' + id + '"');
			this._dataTransferDownloadAndPasteAsync(meta, destination);
			return;
		}

		var content;
		if (dataTransfer == null)
			content = this._encodeHtmlToBlob(htmlText);
		else // Suck HTML content out of dataTransfer now while it feels like working.
			content = this._readContentSyncToBlob(dataTransfer);

		// FIXME: do we want this section ?

		// Images get a look in only if we have no content and are async
		if (content == null && pasteHtml == '' && dataTransfer != null)
		{
			var types = dataTransfer.types;

			console.log('Attempting to paste image(s)');

			// first try to transfer images
			// TODO if we have both Files and a normal mimetype, should we handle
			// both, or prefer one or the other?
			for (var t = 0; t < types.length; ++t) {
				console.log('\ttype' + types[t]);
				if (types[t] === 'Files') {
					var files = dataTransfer.files;
					for (var f = 0; f < files.length; ++f) {
						var file = files[f];
						if (file.type.match(/image.*/)) {
							var reader = new FileReader();
							reader.onload = this._onFileLoadFunc(file);
							reader.readAsArrayBuffer(file);
						}
					}
				}
			}
			return;
		}

		if (content != null) {
			console.log('Normal HTML, so smart paste not possible');

			var formData = new FormData();
			formData.append('file', content);

			var that = this;
			this._doAsyncDownload('POST', destination, formData,
					      function() {
						      console.log('Posted ' + content.size + ' bytes successfully');
						      that._map._socket.sendMessage('uno .uno:Paste');
					      },
					      function(progress) { return progress; }
					     );
		} else {
			console.log('Nothing we can paste on the clipboard');
		}
	},

	populateClipboard: function(ev) {
		var t = this._map._docLayer._selectionType();
		var text;
		if (t === null) {
			console.log('Copy/Cut with no selection!');
			text = this.getStubHtml();
		} else if (t === 'complex') {
			console.log('Copy/Cut with complex/graphical selection');
			text = this.getStubHtml();
			this._onDownloadOnLargeCopyPaste();
			this._downloadProgress.setURI( // richer, bigger HTML ...
				this.getMetaBase() + this.getMetaPath() + '&MimeType=text/html');
		} else {
			console.log('Copy/Cut with simple text selection');
			text = this._selectionContent;
		}

		var plainText = this.stripHTML(text);
		if (ev.clipboardData) { // Standard
			ev.clipboardData.setData('text/plain', plainText);
			ev.clipboardData.setData('text/html', text);
			console.log('Put "' + text + '" on the clipboard');
			this._clipboardSerial++;

		} else if (window.clipboardData) { // IE 11 - poor clipboard API
			if (window.clipboardData.setData('Text', plainText))
				this._clipboardSerial++;
		}
	},

	_createDummyDiv: function(htmlContent) {
		var div = document.createElement('div');
		div.setAttribute('style', 'user-select: text !important');
		div.style.opacity = 0;
		div.setAttribute('contenteditable', 'true');
		div.setAttribute('type', 'text');
		div.setAttribute('style', '-webkit-user-select: text !important');
		div.innerHTML = htmlContent;

		// so we get events to where we want them.
		var parent = document.getElementById('map');
		parent.appendChild(div);

		return div;
	},

	// only used by IE.
	beforepaste: function() {
		console.log('Before paste');
		if (!window.isInternetExplorer)
			return;

		console.log('IE11 madness ...'); // TESTME ...
		var div = this._createDummyDiv('---copy-paste-canary---');
		var sel = document.getSelection();
		// we need to restore focus.
		var active = document.activeElement;
		// get a selection first - FIXME: use Ivan's 2 spaces on input.
		var range = document.createRange();
		range.selectNodeContents(div);
		sel.removeAllRanges();
		sel.addRange(range);
		div.focus();

		var that = this;
		// Now we wait for paste ...
		div.addEventListener('paste', function() {
			// Can't get HTML until it is pasted ... so quick timeout
			setTimeout(function() {
				console.log('Content pasted');
				that.dataTransferToDocument(null, false, div.innerHTML);
				div.parentNode.removeChild(div);
				// attempt to restore focus.
				if (active == null)
					that._map.focus();
				else
					active.focus();
				that._map._clipboardContainer._abortComposition();
				that._clipboardSerial++;
			}, 0 /* ASAP */);
		});
	},

	// Try-harder fallbacks for emitting cut/copy/paste events.
	_execOnElement: function(operation) {
		var serial = this._clipboardSerial;

		var div = this._createDummyDiv('dummy content');

		var that = this;
		var listener = function(e) {
			e.preventDefault();
			console.log('Got event ' + operation + ' on transient editable');
			// forward with proper security credentials now.
			that[operation].call(that, e);
		};
		div.addEventListener('copy', listener);
		div.addEventListener('cut', listener);
		div.addEventListener('paste', listener);

		var success = false;
		var active = null;
		var sel = document.getSelection();
		if (sel)
		{
			// selection can change focus.
			active = document.activeElement;

			// get a selection first - FIXME: use Ivan's 2 spaces on input.
			var range = document.createRange();
			range.selectNodeContents(div);
			sel.removeAllRanges();
			sel.addRange(range);

			success = (document.execCommand(operation) &&
				   serial !== this._clipboardSerial);
		}
		// cleanup
		div.removeEventListener('paste', listener);
		div.removeEventListener('cut', listener);
		div.removeEventListener('copy', listener);
		div.parentNode.removeChild(div);

		// try to restore focus if we need to.
		if (active !== null && active !== document.activeElement)
			active.focus();

		console.log('fallback ' + operation + ' ' + (success?'success':'fail'));

		return success;
	},

	// Encourage browser(s) to actually execute the command
	_execCopyCutPaste: function(operation) {
		var serial = this._clipboardSerial;

		// try execCommand.
		if (document.execCommand(operation) &&
		    serial !== this._clipboardSerial) {
			console.log('copied successfully');
			return;
		}

		// try a hidden div
		if (this._execOnElement(operation)) {
			console.log('copied on element successfully');
			return;
		}

		console.log('failed to ' + operation);
		this._warnCopyPaste();
	},

	// Pull UNO clipboard commands out from menus and normal user input.
	// We try to massage and re-emit these, to get good security event / credentials.
	filterExecCopyPaste: function(cmd) {
		if (cmd === '.uno:Copy') {
			this._execCopyCutPaste('copy');
		} else if (cmd === '.uno:Cut') {
			this._execCopyCutPaste('cut');
		} else if (cmd === '.uno:Paste') {
			this._execCopyCutPaste('paste');
		} else {
			return false;
		}
		console.log('filtered uno command ' + cmd);
		return true;
	},

	copy: function(ev) {
		console.log('Copy');
		ev.preventDefault();
		this.populateClipboard(ev);
		this._map._socket.sendMessage('uno .uno:Copy');
	},

	cut: function(ev) {
		console.log('Cut');
		ev.preventDefault();
		this.populateClipboard(ev);
		this._map._socket.sendMessage('uno .uno:Cut');
	},

	paste: function(ev) {
		console.log('Paste');
		if (ev.clipboardData) { // Standard
			ev.preventDefault();
			this.dataTransferToDocument(ev.clipboardData, /* preferInternal = */ true);
			this._map._clipboardContainer._abortComposition();
			this._clipboardSerial++;
		}
		// else: IE 11 - code in beforepaste: above.
	},

	clearSelection: function() {
		this._selectionContent = '';
	},

	setSelection: function(content) {
		this._selectionContent = content;
	},

	// textselectioncontent: message
	setTextSelectionContent: function(text) {
		this.setSelection(text);
	},

	// complexselection: message
	onComplexSelection: function (text) {
		// Put in the clipboard a helpful explanation of what the user should do.
		// Currently we don't have a payload, though we might in the future
		text = _('Please use the following link to download the selection from you document and paste into other applications on your device')
			+ ': '; //FIXME: MISSING URL
		this.setSelection(text);

		//TODO: handle complex selection download.
	},

	_startProgress: function() {
		if (!this._downloadProgress) {
			this._downloadProgress = L.control.downloadProgress();
		}
		if (!this._downloadProgress.isVisible()) {
			this._downloadProgress.addTo(this._map);
		}
		this._downloadProgress.show();
	},

	_onDownloadOnLargeCopyPaste: function () {
		if (!this._downloadProgress) {
			this._warnFirstLargeCopyPaste();
			this._startProgress();
		}
		else {
			// Need to show this only when a download is really in progress and we block it.
			// Otherwise, it's easier to flasht the widget or something.
			// this._warnLargeCopyPasteAlreadyStarted();
			//this._downloadProgress._onComplete();
		}
	},

	_userAlreadyWarned: function (warning) {
		var currentViewId = this._map._docLayer._viewId;
		var currentUser = this._map._viewInfo[currentViewId].username;
		var itemKey = warning + '_' + currentUser;
		if (!localStorage.getItem(itemKey)) {
			localStorage.setItem(itemKey, '1');
			return false;
		}
		return true;
	},

	_warnCopyPaste: function() {
		var self = this;
		var msg;
		if (L.Browser.mobile) {
			msg = _('<p>Your browser has very limited access to the clipboard</p>');
		} else {
			msg = _('<p>Your browser has very limited access to the clipboard, so use these keyboard shortcuts:<ul><li><b>Ctrl+C</b>: For copying.</li><li><b>Ctrl+X</b>: For cutting.</li><li><b>Ctrl+V</b>: For pasting.</li></ul></p>');
		}
		vex.dialog.alert({
			message: msg,
			callback: function () {
				self._map.focus();
			}
		});
	},

	_warnFirstLargeCopyPaste: function () {
		if (this._userAlreadyWarned('warnedAboutLargeCopy'))
			return;

		var self = this;
		vex.dialog.alert({
			message: _('<p>When copying larger pieces of your document, to share them with other applications ' +
				       'on your device for security reasons, please select the "Start download" button below. ' +
				       'A progress bar will show you the download advance. When it is complete select ' +
				       'the "Confirm copy to clipboard" button in order to copy the downloaded data to your clipboard. ' +
				       'At any time you can cancel the download by selecting the top right "X" button.</p>'),
			callback: function () {
				self._map.focus();
			}
		});
	},

	_warnLargeCopyPasteAlreadyStarted: function () {
		var self = this;
		vex.dialog.alert({
			message: _('<p>A download  due to a large copy/paste operation has already started. ' +
				       'Please, wait for the current download to complete before starting a new one</p>'),
			callback: function () {
				self._map.focus();
			}
		});
	},

});

L.clipboard = function(map) {
	return new L.Clipboard(map);
};