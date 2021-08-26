// ==UserScript==
// @id           thm-iitc@tehstone
// @name         THM Tools
// @category     Layer
// @version      0.0.1
// @description  Transformers: Heavy Metal tools over IITC
// @author       tehstone
// @match        https://www.ingress.com/intel*
// @match        https://ingress.com/intel*
// @match        https://intel.ingress.com/*
// @grant        none
// ==/UserScript==

/* eslint-env es6 */
/* eslint no-var: "error" */
/* globals L, S2, map */
/* globals GM_info, $, dialog */
/* globals renderPortalDetails, findPortalGuidByPositionE6 */

/** S2 Geometry functions

 S2 extracted from Regions Plugin
 https:static.iitc.me/build/release/plugins/regions.user.js

 the regional scoreboard is based on a level 6 S2 Cell
 - https:docs.google.com/presentation/d/1Hl4KapfAENAOf4gv-pSngKwvS_jwNVHRPZTTDzXXn6Q/view?pli=1#slide=id.i22
 at the time of writing there's no actual API for the intel map to retrieve scoreboard data,
 but it's still useful to plot the score cells on the intel map


 the S2 geometry is based on projecting the earth sphere onto a cube, with some scaling of face coordinates to
 keep things close to approximate equal area for adjacent cells
 to convert a lat,lng into a cell id:
 - convert lat,lng to x,y,z
 - convert x,y,z into face,u,v
 - u,v scaled to s,t with quadratic formula
 - s,t converted to integer i,j offsets
 - i,j converted to a position along a Hubbert space-filling curve
 - combine face,position to get the cell id

 NOTE: compared to the google S2 geometry library, we vary from their code in the following ways
 - cell IDs: they combine face and the hilbert curve position into a single 64 bit number. this gives efficient space
             and speed. javascript doesn't have appropriate data types, and speed is not cricical, so we use
             as [face,[bitpair,bitpair,...]] instead
 - i,j: they always use 30 bits, adjusting as needed. we use 0 to (1<<level)-1 instead
        (so GetSizeIJ for a cell is always 1)
*/

;function wrapperS2() { // eslint-disable-line no-extra-semi

  const S2 = window.S2 = {};

  function LatLngToXYZ(latLng) {
    const d2r = Math.PI / 180.0;
    const phi = latLng.lat * d2r;
    const theta = latLng.lng * d2r;
    const cosphi = Math.cos(phi);

    return [Math.cos(theta) * cosphi, Math.sin(theta) * cosphi, Math.sin(phi)];
  }

  function XYZToLatLng(xyz) {
    const r2d = 180.0 / Math.PI;

    const lat = Math.atan2(xyz[2], Math.sqrt(xyz[0] * xyz[0] + xyz[1] * xyz[1]));
    const lng = Math.atan2(xyz[1], xyz[0]);

    return {lat: lat * r2d, lng: lng * r2d};
  }

  function largestAbsComponent(xyz) {
    const temp = [Math.abs(xyz[0]), Math.abs(xyz[1]), Math.abs(xyz[2])];

    if (temp[0] > temp[1]) {
      if (temp[0] > temp[2]) {
        return 0;
      }
      return 2;
    }

    if (temp[1] > temp[2]) {
      return 1;
    }

    return 2;
  }

  function faceXYZToUV(face,xyz) {
    let u, v;

    switch (face) {
      case 0: u =  xyz[1] / xyz[0]; v =  xyz[2] / xyz[0]; break;
      case 1: u = -xyz[0] / xyz[1]; v =  xyz[2] / xyz[1]; break;
      case 2: u = -xyz[0] / xyz[2]; v = -xyz[1] / xyz[2]; break;
      case 3: u =  xyz[2] / xyz[0]; v =  xyz[1] / xyz[0]; break;
      case 4: u =  xyz[2] / xyz[1]; v = -xyz[0] / xyz[1]; break;
      case 5: u = -xyz[1] / xyz[2]; v = -xyz[0] / xyz[2]; break;
      default: throw {error: 'Invalid face'};
    }

    return [u,v];
  }

  function XYZToFaceUV(xyz) {
    let face = largestAbsComponent(xyz);

    if (xyz[face] < 0) {
      face += 3;
    }

    const uv = faceXYZToUV(face, xyz);

    return [face, uv];
  }

  function FaceUVToXYZ(face, uv) {
    const u = uv[0];
    const v = uv[1];

    switch (face) {
      case 0: return [1, u, v];
      case 1: return [-u, 1, v];
      case 2: return [-u,-v, 1];
      case 3: return [-1,-v,-u];
      case 4: return [v,-1,-u];
      case 5: return [v, u,-1];
      default: throw {error: 'Invalid face'};
    }
  }

  function STToUV(st) {
    const singleSTtoUV = function (st) {
      if (st >= 0.5) {
        return (1 / 3.0) * (4 * st * st - 1);
      }
      return (1 / 3.0) * (1 - (4 * (1 - st) * (1 - st)));

    };

    return [singleSTtoUV(st[0]), singleSTtoUV(st[1])];
  }

  function UVToST(uv) {
    const singleUVtoST = function (uv) {
      if (uv >= 0) {
        return 0.5 * Math.sqrt (1 + 3 * uv);
      }
      return 1 - 0.5 * Math.sqrt (1 - 3 * uv);

    };

    return [singleUVtoST(uv[0]), singleUVtoST(uv[1])];
  }

  function STToIJ(st,order) {
    const maxSize = 1 << order;

    const singleSTtoIJ = function (st) {
      const ij = Math.floor(st * maxSize);
      return Math.max(0, Math.min(maxSize - 1, ij));
    };

    return [singleSTtoIJ(st[0]), singleSTtoIJ(st[1])];
  }

  function IJToST(ij,order,offsets) {
    const maxSize = 1 << order;

    return [
      (ij[0] + offsets[0]) / maxSize,
      (ij[1] + offsets[1]) / maxSize
    ];
  }

  // S2Cell class
  S2.S2Cell = function () {};

  //static method to construct
  S2.S2Cell.FromLatLng = function (latLng, level) {
    const xyz = LatLngToXYZ(latLng);
    const faceuv = XYZToFaceUV(xyz);
    const st = UVToST(faceuv[1]);
    const ij = STToIJ(st,level);

    return S2.S2Cell.FromFaceIJ(faceuv[0], ij, level);
  };

  S2.S2Cell.FromFaceIJ = function (face, ij, level) {
    const cell = new S2.S2Cell();
    cell.face = face;
    cell.ij = ij;
    cell.level = level;

    return cell;
  };

  S2.S2Cell.prototype.toString = function () {
    return 'F' + this.face + 'ij[' + this.ij[0] + ',' + this.ij[1] + ']@' + this.level;
  };

  S2.S2Cell.prototype.getLatLng = function () {
    const st = IJToST(this.ij, this.level, [0.5, 0.5]);
    const uv = STToUV(st);
    const xyz = FaceUVToXYZ(this.face, uv);

    return XYZToLatLng(xyz);
  };

  S2.S2Cell.prototype.getCornerLatLngs = function () {
    const offsets = [
      [0.0, 0.0],
      [0.0, 1.0],
      [1.0, 1.0],
      [1.0, 0.0]
    ];

    return offsets.map(offset => {
      const st = IJToST(this.ij, this.level, offset);
      const uv = STToUV(st);
      const xyz = FaceUVToXYZ(this.face, uv);

      return XYZToLatLng(xyz);
    });
  };

  S2.S2Cell.prototype.getNeighbors = function (deltas) {

    const fromFaceIJWrap = function (face,ij,level) {
      const maxSize = 1 << level;
      if (ij[0] >= 0 && ij[1] >= 0 && ij[0] < maxSize && ij[1] < maxSize) {
        // no wrapping out of bounds
        return S2.S2Cell.FromFaceIJ(face,ij,level);
      }

      // the new i,j are out of range.
      // with the assumption that they're only a little past the borders we can just take the points as
      // just beyond the cube face, project to XYZ, then re-create FaceUV from the XYZ vector
      let st = IJToST(ij,level,[0.5, 0.5]);
      let uv = STToUV(st);
      let xyz = FaceUVToXYZ(face, uv);
      const faceuv = XYZToFaceUV(xyz);
      face = faceuv[0];
      uv = faceuv[1];
      st = UVToST(uv);
      ij = STToIJ(st,level);
      return S2.S2Cell.FromFaceIJ(face, ij, level);
    };

    const face = this.face;
    const i = this.ij[0];
    const j = this.ij[1];
    const level = this.level;

    if (!deltas) {
      deltas = [
        {a: -1, b: 0},
        {a: 0, b: -1},
        {a: 1, b: 0},
        {a: 0, b: 1}
      ];
    }
    return deltas.map(function (values) {
      return fromFaceIJWrap(face, [i + values.a, j + values.b], level);
    });
  };
}

/** Our code
* For safety, S2 must be initialized before our code
*
* Code is modified from the Pokemon GO plugin
* https://gitlab.com/AlfonsoML/pogo-s2/raw/master/s2check.user.js
*/
function wrapperPlugin(plugin_info) {
  'use strict';

  // based on https://github.com/iatkin/leaflet-svgicon
  function initSvgIcon() {
    L.DivIcon.SVGIcon = L.DivIcon.extend({
      options: {
        'className': 'svg-icon',
        'iconAnchor': null, //defaults to [iconSize.x/2, iconSize.y] (point tip)
        'iconSize': L.point(48, 48)
      },
      initialize: function (options) {
        options = L.Util.setOptions(this, options);

        //iconSize needs to be converted to a Point object if it is not passed as one
        options.iconSize = L.point(options.iconSize);

        if (!options.iconAnchor) {
          options.iconAnchor = L.point(Number(options.iconSize.x) / 2, Number(options.iconSize.y));
        } else {
          options.iconAnchor = L.point(options.iconAnchor);
        }
      },

      // https://github.com/tonekk/Leaflet-Extended-Div-Icon/blob/master/extended.divicon.js#L13
      createIcon: function (oldIcon) {
        let div = L.DivIcon.prototype.createIcon.call(this, oldIcon);

        if (this.options.id) {
          div.id = this.options.id;
        }

        if (this.options.style) {
          for (let key in this.options.style) {
            div.style[key] = this.options.style[key];
          }
        }
        return div;
      }
    });

    L.divIcon.svgIcon = function (options) {
      return new L.DivIcon.SVGIcon(options);
    };

    L.Marker.SVGMarker = L.Marker.extend({
      options: {
        'iconFactory': L.divIcon.svgIcon,
        'iconOptions': {}
      },
      initialize: function (latlng, options) {
        options = L.Util.setOptions(this, options);
        options.icon = options.iconFactory(options.iconOptions);
        this._latlng = latlng;
      },
      onAdd: function (map) {
        L.Marker.prototype.onAdd.call(this, map);
      }
    });

    L.marker.svgMarker = function (latlng, options) {
      return new L.Marker.SVGMarker(latlng, options);
    };
  }

  /**
   * Saves a file to disk with the provided text
   * @param {string} text - The text to save
   * @param {string} filename - Proposed filename
   */
  function saveToFile(text, filename) {
    if (typeof text != 'string') {
      text = JSON.stringify(text);
    }

    if (typeof window.android !== 'undefined' && window.android.saveFile) {
      window.android.saveFile(filename, 'application/json', text);
      return;
    }

    if (isIITCm()) {
      promptForCopy(text);
      return;
    }

    // http://stackoverflow.com/a/18197341/250294
    const element = document.createElement('a');
    // fails with large amounts of data
    // element.setAttribute('href', 'data:text/plain;charset=utf-8,' + encodeURIComponent(text));

    // http://stackoverflow.com/questions/13405129/javascript-create-and-save-file
    const file = new Blob([text], {type: 'text/plain'});
    element.setAttribute('href', URL.createObjectURL(file));

    element.setAttribute('download', filename);

    element.style.display = 'none';
    document.body.appendChild(element);

    element.click();

    document.body.removeChild(element);
  }

  /**
   * Prompts the user to select a file and then reads its contents and calls the callback function with those contents
   * @param {Function} callback - Function that will be called when the file is read.
   * Callback signature: function( {string} contents ) {}
   */
  function readFromFile(callback) {
    // special hook from iitcm
    if (typeof window.requestFile != 'undefined') {
      window.requestFile(function (filename, content) {
        callback(content);
      });
      return;
    }

    if (isIITCm()) {
      promptForPaste(callback);
      return;
    }

    const input = document.createElement('input');
    input.type = 'file';
    input.className = 'baseutils-filepicker';
    document.body.appendChild(input);

    input.addEventListener('change', function () {
      const reader = new FileReader();
      reader.onload = function () {
        callback(reader.result);
      };
      reader.readAsText(input.files[0]);
      document.body.removeChild(input);
    }, false);

    input.click();
  }

  function promptForPaste(callback) {
    const div = document.createElement('div');

    const textarea = document.createElement('textarea');
    textarea.style.width = '100%';
    textarea.style.minHeight = '8em';
    div.appendChild(textarea);

    const container = dialog({
      id: 'promptForPaste',
      html: div,
      width: '360px',
      title: 'Paste here the data',
      buttons: {
        OK: function () {
          container.dialog('close');
          callback(textarea.value);
        }
      }
    });
  }

  function promptForCopy(text) {
    const div = document.createElement('div');

    const textarea = document.createElement('textarea');
    textarea.style.width = '100%';
    textarea.style.minHeight = '8em';
    textarea.value = text;
    div.appendChild(textarea);

    const container = dialog({
      id: 'promptForCopy',
      html: div,
      width: '360px',
      title: 'Copy this data',
      buttons: {
        OK: function () {
          container.dialog('close');
        }
      }
    });
  }

  const TIMERS = {};
  function createThrottledTimer(name, callback, ms) {
    if (TIMERS[name])
      clearTimeout(TIMERS[name]);

    // throttle if there are several calls to the functions
    TIMERS[name] = setTimeout(function() {
      delete TIMERS[name];
      if (typeof window.requestIdleCallback == 'undefined')
        callback();
      else
        // and even now, wait for iddle
        requestIdleCallback(function() {
          callback();
        }, { timeout: 2000 });

    }, ms || 100);
  }

  /**
   * Try to identify if the browser is IITCm due to special bugs like file picker not working
   */
  function isIITCm() {
    const ua = navigator.userAgent;
    if (!ua.match(/Android.*Mobile/))
      return false;

    if (ua.match(/; wb\)/))
      return true;

    return ua.match(/ Version\//);
  }

  let signalposts = {};
  let raids = {};
  // Portals that aren't marked as THM items
  let notthm = {};

  let allPortals = {};
  let newPortals = {};
  let checkNewPortalsTimout;

  // Portals that the user hasn't classified (2 or more in the same Lvl17 cell)
  let skippedPortals = {};
  // let newPokestops = {};
  let notClassifiedPois = [];

  // Portals that we know, but that have been moved from our stored location.
  let movedPortals = [];

  // THM items that are no longer available.
  let missingPortals = {};

  // Leaflet layers
  let regionLayer; // s2 grid
  let signalpostLayerGroup; // signal posts
  let raidLayerGroup; // raids
  let notthmLayerGroup; // not in ThM (N/A)
  let nearbyGroupLayer; // circles to mark the too near limit

  // Group of items added to the layer
  let signalpostLayers = {};
  let raidLayers = {};
  let notthmLayers = {};
  let nearbyCircles = {};

  const defaultSettings = {
    //highlightGymCandidateCells: false,
    //highlightGymCenter: false,
    thisIsTHM: false,
    analyzeForMissingData: true,
    grids: [
      {
        level: 6,
        width: 5,
        color: '#004D40',
        opacity: 0.5
      },
      {
        level: 0,
        width: 2,
        color: '#388E3C',
        opacity: 0.5
      }
    ],
    colors: {
      cell16Filled: {
        color: '#000000',
        opacity: 0.6
      },
      cell14Filled: {
        color: '#000000',
        opacity: 0.5
      },
      nearbyCircleBorder: {
        color: '#000000',
        opacity: 0.6
      },
      nearbyCircleFill: {
        color: '#000000',
        opacity: 0.4
      },
    },
    saveDataType: 'SignalPosts',
    saveDataFormat: 'CSV'
  };

  let settings = defaultSettings;

  function saveSettings() {
    createThrottledTimer('saveSettings', function() {
      localStorage['thm_settings'] = JSON.stringify(settings);
    });
  }

  function loadSettings() {
    const tmp = localStorage['thm_settings'] || localStorage['s2check_settings'];
    if (!tmp)
      return;
    try  {
      settings = JSON.parse(tmp);
    } catch (e) { // eslint-disable-line no-empty
    }
    if (typeof settings.analyzeForMissingData == 'undefined') {
      settings.analyzeForMissingData = true;
    }
    if (typeof settings.promptForMissingData != 'undefined') {
      delete settings.promptForMissingData;
    }
    if (!settings.colors) {
      resetColors();
    }
    if (typeof settings.saveDataType == 'undefined') {
      settings.saveDataType = 'SignalPosts';
    }
    if (typeof settings.saveDataFormat == 'undefined') {
      settings.saveDataFormat = 'CSV';
    }

    setThisIsTHM();
  }

  function resetColors() {
    settings.grids[0].color = defaultSettings.grids[0].color;
    settings.grids[0].opacity = defaultSettings.grids[0].opacity;
    settings.grids[1].color = defaultSettings.grids[1].color;
    settings.grids[1].opacity = defaultSettings.grids[1].opacity;
    settings.colors = defaultSettings.colors;
  }

  let originalHighlightPortal;

  function setThisIsTHM() {
    document.body.classList[settings.thisIsTHM ? 'add' : 'remove']('thisIsTHM');

    if (settings.thisIsTHM) {
      removeIngressLayers();
      if (window._current_highlighter == window._no_highlighter) {
        // extracted from IITC plugin: Hide portal ownership

        originalHighlightPortal = window.highlightPortal;
        window.highlightPortal = portal => {
          window.portalMarkerScale();
          const hidePortalOwnershipStyles = window.getMarkerStyleOptions({team: window.TEAM_NONE, level: 0});
          portal.setStyle(hidePortalOwnershipStyles);
        };
        window.resetHighlightedPortals();
      }
    } else {
      restoreIngressLayers();
      if (originalHighlightPortal != null) {
        window.highlightPortal = originalHighlightPortal;
        originalHighlightPortal = null;
        window.resetHighlightedPortals();
      }
    }
  }

  function sortByName(a, b) {
    if (!a.name)
      return -1;

    return a.name.localeCompare(b.name);
  }

  function isCellOnScreen(mapBounds, cell) {
    const corners = cell.getCornerLatLngs();
    const cellBounds = L.latLngBounds([corners[0],corners[1]]).extend(corners[2]).extend(corners[3]);
    return cellBounds.intersects(mapBounds);
  }

  // return only the cells that are visible by the map bounds to ignore far away data that might not be complete
  function filterWithinScreen(cells) {
    const bounds = map.getBounds();
    const filtered = {};
    Object.keys(cells).forEach(cellId => {
      const cellData = cells[cellId];
      const cell = cellData.cell;

      if (isCellInsideScreen(bounds, cell)) {
        filtered[cellId] = cellData;
      }
    });
    return filtered;
  }

  function isCellInsideScreen(mapBounds, cell) {
    const corners = cell.getCornerLatLngs();
    const cellBounds = L.latLngBounds([corners[0],corners[1]]).extend(corners[2]).extend(corners[3]);
    return mapBounds.contains(cellBounds);
  }

  /**
  * Filter a group of items (signal posts/raids) excluding those out of the screen
  */
  function filterItemsByMapBounds(items) {
    const bounds = map.getBounds();
    const filtered = {};
    Object.keys(items).forEach(id => {
      const item = items[id];

      if (isPointOnScreen(bounds, item)) {
        filtered[id] = item;
      }
    });
    return filtered;
  }

  function isPointOnScreen(mapBounds, point) {
    if (point._latlng)
      return mapBounds.contains(point._latlng);

    return mapBounds.contains(L.latLng(point));
  }

  function groupByCell(level) {
    const cells = {};
    classifyGroup(cells, signalposts, level, (cell, item) => cell.signalposts.push(item));
    classifyGroup(cells, raids, level, (cell, item) => cell.raids.push(item));
    classifyGroup(cells, newPortals, level, (cell, item) => cell.notClassified.push(item));
    classifyGroup(cells, notthm, level, (cell, item) => cell.notTHM.push(item));

    return cells;
  }

  function classifyGroup(cells, items, level, callback) {
    Object.keys(items).forEach(id => {
      const item = items[id];
      if (!item.cells) {
        item.cells = {};
      }
      let cell;
      // Compute the cell only once for each level
      if (!item.cells[level]) {
        cell = window.S2.S2Cell.FromLatLng(item, level);
        item.cells[level] = cell.toString();
      }
      const cellId = item.cells[level];

      // Add it to the array of POIs of that cell
      if (!cells[cellId]) {
        if (!cell) {
          cell = window.S2.S2Cell.FromLatLng(item, level);
        }
        cells[cellId] = {
          cell: cell,
          signalposts: [],
          raids: [],
          notClassified: [],
          notTHM: []
        };
      }
      callback(cells[cellId], item);
    });
  }

  /**
   * Returns the items that belong to the specified cell
   */
  function findCellItems(cellId, level, items) {
    return Object.values(items).filter(item => {
      return item.cells[level] == cellId;
    });
  }

  /**
    Tries to add the portal photo when exporting from Ingress.com/intel
  */
  function findPhotos(items) {
    if (!window.portals) {
      return items;
    }
    Object.keys(items).forEach(id => {
      const item = items[id];
      if (item.image)
        return;

      const portal = window.portals[id];
      if (portal && portal.options && portal.options.data) {
        item.image = portal.options.data.image;
      }
    });
    return items;
  }

  function configureGridLevelSelect(select, i) {
    select.value = settings.grids[i].level;
    select.addEventListener('change', e => {
      settings.grids[i].level = parseInt(select.value, 10);
      saveSettings();
      updateMapGrid();
    });
  }

  function showS2Dialog() {
    const selectRow = `
      <p>{{level}} level of grid to display: <select>
      <option value=0>None</option>
      <option value=6>6</option>
      <option value=7>7</option>
      <option value=8>8</option>
      <option value=9>9</option>
      <option value=10>10</option>
      <option value=11>11</option>
      <option value=12>12</option>
      <option value=13>13</option>
      <option value=14>14</option>
      <option value=15>15</option>
      <option value=16>16</option>
      <option value=17>17</option>
      <option value=18>18</option>
      <option value=19>19</option>
      <option value=20>20</option>
      </select></p>`;

    const html =
      selectRow.replace('{{level}}', '1st') +
      selectRow.replace('{{level}}', '2nd') +
      `<!-- p><label><input type="checkbox" id="chkHighlightCandidates">Highlight Cells that might get a Gym</label></p>
      <p><label><input type="checkbox" id="chkHighlightCenters">Highlight centers of Cells with a Gym</label></p -->
      <p><label title='Hide Ingress panes, info and whatever that clutters the map and it is useless for THM'><input type="checkbox" id="chkThisIsTHM">This is THM!</label></p>
      <p><label title="Analyze the portal data to show the pane that suggests new POIs"><input type="checkbox" id="chkanalyzeForMissingData">Analyze portal data</label></p>
      <p><a id='THMEditColors'>Colors</a></p>
       `;

    const container = dialog({
      id: 's2Settings',
      width: 'auto',
      html: html,
      title: 'S2 & THM Settings'
    });

    const div = container[0];

    const selects = div.querySelectorAll('select');
    for (let i = 0; i < 2; i++) {
      configureGridLevelSelect(selects[i], i);
    }

    const chkThisIsTHM = div.querySelector('#chkThisIsTHM');
    chkThisIsTHM.checked = !!settings.thisIsTHM;
    chkThisIsTHM.addEventListener('change', e => {
      settings.thisIsTHM = chkThisIsTHM.checked;
      saveSettings();
      setThisIsTHM();
    });

    const chkanalyzeForMissingData = div.querySelector('#chkanalyzeForMissingData');
    chkanalyzeForMissingData.checked = !!settings.analyzeForMissingData;
    chkanalyzeForMissingData.addEventListener('change', e => {
      settings.analyzeForMissingData = chkanalyzeForMissingData.checked;
      saveSettings();
      if (newPortals.length > 0) {
        checkNewPortals();
      }
    });

    const THMEditColors = div.querySelector('#THMEditColors');
    THMEditColors.addEventListener('click', function (e) {
      editColors();
      e.preventDefault();
      return false;
    });
  }

  function editColors() {
    const selectRow = `<p class='thm-colors'>{{title}}<br>
      Color: <input type='color' id='{{id}}Color'> Opacity: <select id='{{id}}Opacity'>
      <option value=0>0</option>
      <option value=0.1>0.1</option>
      <option value=0.2>0.2</option>
      <option value=0.3>0.3</option>
      <option value=0.4>0.4</option>
      <option value=0.5>0.5</option>
      <option value=0.6>0.6</option>
      <option value=0.7>0.7</option>
      <option value=0.8>0.8</option>
      <option value=0.9>0.9</option>
      <option value=1>1</option>
      </select></p>`;

    const html =
      selectRow.replace('{{title}}', '1st Grid').replace(/{{id}}/g, 'grid0') +
      selectRow.replace('{{title}}', '2nd Grid').replace(/{{id}}/g, 'grid1') +
      selectRow.replace('{{title}}', 'Border of too close circles').replace(/{{id}}/g, 'nearbyCircleBorder') +
      selectRow.replace('{{title}}', 'Fill of too close circles').replace(/{{id}}/g, 'nearbyCircleFill') +
      '<a id="resetColorsLink">Reset all colors</a>'
      ;

    const container = dialog({
      id: 's2Colors',
      width: 'auto',
      html: html,
      title: 'THM grid Colors'
    });

    const div = container[0];

    const updatedSetting = function (id) {
      saveSettings();
      if (id == 'nearbyCircleBorder' || id == 'nearbyCircleFill') {
        redrawNearbyCircles();
      } else {
        updateMapGrid();
      }
    };

    const configureItems = function (key, item, id) {
      if (!id)
        id = item;

      const entry = settings[key][item];
      const select = div.querySelector('#' + id + 'Opacity');
      select.value = entry.opacity;
      select.addEventListener('change', function (event) {
        settings[key][item].opacity = select.value;
        updatedSetting(id);
      });

      const input = div.querySelector('#' + id + 'Color');
      input.value = entry.color;
      input.addEventListener('change', function (event) {
        settings[key][item].color = input.value;
        updatedSetting(id);
      });
    };

    configureItems('grids', 0, 'grid0');
    configureItems('grids', 1, 'grid1');
    configureItems('colors', 'nearbyCircleBorder');
    configureItems('colors', 'nearbyCircleFill');

    const resetColorsLink = div.querySelector('#resetColorsLink');
    resetColorsLink.addEventListener('click', function() {
      container.dialog('close');
      resetColors();
      updatedSetting('nearbyCircleBorder');
      updatedSetting();
      editColors();
    });
  }

  /**
   * Refresh the S2 grid over the map
   */
  function updateMapGrid() {
    regionLayer.clearLayers();

    if (!map.hasLayer(regionLayer))
      return;

    const bounds = map.getBounds();
    const seenCells = {};
    const signalpostsByCell = {};
    const deltas = [
      {a: -1, b: 0},
      {a: -1, b: -1},
      {a: 0, b: -1},
      {a: 1, b: -1},
      {a: 1, b: 0},
      {a: 1, b: 1},
      {a: 0, b: 1},
      {a: -1, b: 1}
    ];
    const drawCellAndNeighbors = function (cell, color, width, opacity) {
      const cellStr = cell.toString();

      if (!seenCells[cellStr]) {
        // cell not visited - flag it as visited now
        seenCells[cellStr] = true;

        if (isCellOnScreen(bounds, cell)) {
          // on screen - draw it
          drawCell(cell, color, width, opacity);

          // and recurse to our neighbors
          const neighbors = cell.getNeighbors(deltas);
          for (let i = 0; i < neighbors.length; i++) {
            drawCellAndNeighbors(neighbors[i], color, width, opacity);
          }

          // add cell score
          let cellsWithSignalposts = 0;
          let totalSignalposts = 0;
          let hasUnknown = false;
          for (let i = 0; i < neighbors.length; ++i) {
            let data = signalpostsByCell[neighbors[i]];
            if (data && data.signalposts.length) {
              signalpostsByCell++;
              totalSignalposts += data.signalposts.length;
            }
            if (data && data.notClassified.length) {
              hasUnknown = true;
            }
          }

          let data = signalpostsByCell[cell];
          if (data && data.notClassified.length) {
            hasUnknown = true;
          }
          let score = data && data.signalposts.length || 0;
          let scoreMarker;
          if (totalSignalposts > 0) {
            score += totalSignalposts / cellsWithSignalposts;
          }
          if (score > 0) {
            scoreMarker = L.marker(cell.getLatLng(), {
              icon: L.divIcon({
                className: 's2score',
                iconSize: [40, 40],
                iconAnchor: [20, 20],
                html: '<span>' + score.toFixed(1) + (hasUnknown ? '?' : '') + '</span>'
              }),
              clickable: false,
              interactive: false
            });
            signalpostscoreLayer.addLayer(scoreMarker);
          }
        }
      }
    };

    // center cell
    const zoom = map.getZoom();
    if (zoom < 5) {
      return;
    }
    // first draw nearby circles at the bottom
    if (16 < zoom) {
      regionLayer.addLayer(nearbyGroupLayer);
    }
    // then draw the cell grid
    for (let i = 0; i < settings.grids.length; i++) {
      const grid = settings.grids[i];
      const gridLevel = grid.level;
      if (gridLevel >= 6 && gridLevel < (zoom + 2)) {
        if (gridLevel === 15) {
          classifyGroup(signalpostsByCell, signalposts, gridLevel, (cell, item) => cell.signalposts.push(item));
          classifyGroup(signalpostsByCell, newPortals, gridLevel, (cell, item) => cell.notClassified.push(item));
        }
        const cell = S2.S2Cell.FromLatLng(getLatLngPoint(map.getCenter()), gridLevel);
        drawCellAndNeighbors(cell, grid.color, grid.width, grid.opacity);
      }
    }
  }

  function getLatLngPoint(data) {
    const result = {
      lat: typeof data.lat == 'function' ? data.lat() : data.lat,
      lng: typeof data.lng == 'function' ? data.lng() : data.lng
    };

    return result;
  }

  function drawCell(cell, color, weight, opacity) {
    // corner points
    const corners = cell.getCornerLatLngs();

    // the level 6 cells have noticible errors with non-geodesic lines - and the larger level 4 cells are worse
    // NOTE: we only draw two of the edges. as we draw all cells on screen, the other two edges will either be drawn
    // from the other cell, or be off screen so we don't care
    const region = L.polyline([corners[0], corners[1], corners[2], corners[3], corners[0]], {fill: false, color: color, opacity: opacity, weight: weight, clickable: false, interactive: false});

    regionLayer.addLayer(region);
  }

  function fillCell(cell, color, opacity) {
    // corner points
    const corners = cell.getCornerLatLngs();

    const region = L.polygon(corners, {color: color, fillOpacity: opacity, weight: 0, clickable: false, interactive: false});
    regionLayer.addLayer(region);
  }

  /**
  *  Writes a text in the center of a cell
  */
  function writeInCell(cell, text) {
    // center point
    let center = cell.getLatLng();

    let marker = L.marker(center, {
      icon: L.divIcon({
        className: 's2check-text',
        iconAnchor: [25, 5],
        iconSize: [50, 10],
        html: text
      }),
      interactive: false
    });
    // fixme, maybe add some click handler

    regionLayer.addLayer(marker);
  }

  // ***************************
  // IITC code
  // ***************************


  // ensure plugin framework is there, even if iitc is not yet loaded
  if (typeof window.plugin !== 'function') {
    window.plugin = function () {};
  }

  // PLUGIN START ////////////////////////////////////////////////////////

  // use own namespace for plugin
  window.plugin.thm = function () {};

  const thisPlugin = window.plugin.thm;
  const KEY_STORAGE = 'plugin-thm';

  /*********************************************************************************************************************/

  // Update the localStorage
  thisPlugin.saveStorage = function () {
    createThrottledTimer('saveStorage', function() {
      localStorage[KEY_STORAGE] = JSON.stringify({
        signalposts: cleanUpExtraData(signalposts),
        raids: cleanUpExtraData(raids),
        notthm: cleanUpExtraData(notthm),
      });
    });
  };

  /**
   * Create a new object where the extra properties of each POI have been removed. Store only the minimum.
   */
  function cleanUpExtraData(group) {
    let newGroup = {};
    Object.keys(group).forEach(id => {
      const data = group[id];
      const newData = {
        guid: data.guid,
        lat: data.lat,
        lng: data.lng,
        name: data.name
      };

      if (data.sponsored)
        newData.sponsored = data.sponsored;

      newGroup[id] = newData;
    });
    return newGroup;
  }

  // Load the localStorage
  thisPlugin.loadStorage = function () {
    const tmp = JSON.parse(localStorage[KEY_STORAGE] || '{}');
    signalposts = tmp.signalposts || {};
    raids = tmp.raids || {};
    notthm = tmp.notthm || {};
  };

  thisPlugin.createEmptyStorage = function () {
    signalposts = {};
    notthm = {};
    notthm = {};
    thisPlugin.saveStorage();

    allPortals = {};
    newPortals = {};

    movedPortals = [];
    missingPortals = {};
  };

  /*************************************************************************/

  thisPlugin.findByGuid = function (guid) {
    if (signalposts[guid]) {
      return {'type': 'signalposts', 'store': signalposts};
    }
    if (raids[guid]) {
      return {'type': 'raids', 'store': raids};
    }
    if (notthm[guid]) {
      return {'type': 'notthm', 'store': notthm};
    }
    return null;
  };

  // Append a 'star' flag in sidebar.
  thisPlugin.onPortalSelectedPending = false;
  thisPlugin.onPortalSelected = function () {
    $('.thmSignalpost').remove();
    $('.thmRaid').remove();
    $('.notTHM').remove();
    const portalDetails = document.getElementById('portaldetails');
    portalDetails.classList.remove('isSignalpost');

    if (window.selectedPortal == null) {
      return;
    }

    if (!thisPlugin.onPortalSelectedPending) {
      thisPlugin.onPortalSelectedPending = true;

      setTimeout(function () { // the sidebar is constructed after firing the hook
        thisPlugin.onPortalSelectedPending = false;

        $('.thmSignalpost').remove();
        $('.thmRaid').remove();
        $('.notTHM').remove();

        // Show THM icons in the mobile status-bar
        if (thisPlugin.isSmart) {
          document.querySelector('.THMStatus').innerHTML = thisPlugin.htmlStar;
          $('.THMStatus > a').attr('title', '');
        }

        $(portalDetails).append('<div class="THMButtons">Transformers Heavy Metal: ' + thisPlugin.htmlStar + '</div>'

        thisPlugin.updateStarPortal();
      }, 0);
    }
  };

  // Update the status of the star (when a portal is selected from the map/thm-list)
  thisPlugin.updateStarPortal = function () {
    $('.thmSignalpost').removeClass('favorite');
    $('.thmRaid').removeClass('favorite');
    $('.notTHM').removeClass('favorite');
    document.getElementById('portaldetails').classList.remove('isSignalpost');

    const guid = window.selectedPortal;
    // If current portal is in thm: select thm portal from portals list and select the star
    const thmData = thisPlugin.findByGuid(guid);
    if (thmData) {
      if (thmData.type === 'raids') {
        $('.thmRaid').addClass('favorite');
      }
      if (thmData.type === 'signalposts') {
        $('.thmSignalpost').addClass('favorite');
        document.getElementById('portaldetails').classList.add('isSignalpost');
        const signalpost = signalposts[guid];
      }
      if (thmData.type === 'notthm') {
        $('.notTHM').addClass('favorite');
      }
    }
  };

  function removeTHMObject(type, guid) {
    if (type === 'raids') {
      delete raids[guid];
      const starInLayer = raidLayers[guid];
      raidLayerGroup.removeLayer(starInLayer);
      delete raidLayers[guid];
    }
    if (type === 'signalposts') {
      delete signalposts[guid];
      const signalpostInLayer = signalpostLayers[guid];
      signalpostLayerGroup.removeLayer(signalpostInLayer);
      delete signalpostLayers[guid];
    }
    if (type === 'notthm') {
      delete notthm[guid];
      const notthmInLayer = notthmLayers[guid];
      notthmLayerGroup.removeLayer(notthmInLayer);
      delete notthmLayers[guid];
    }
  }

  // Switch the status of the star
  thisPlugin.switchStarPortal = function (type) {
    const guid = window.selectedPortal;

    // It has been manually classified, remove from the detection
    if (newPortals[guid])
      delete newPortals[guid];

    // If portal is saved in THM: Remove this POI
    const thmData = thisPlugin.findByGuid(guid);
    if (thmData) {
      const existingType = thmData.type;
      removeTHMObject(existingType, guid);

      thisPlugin.saveStorage();
      thisPlugin.updateStarPortal();

      // Get portal name and coordinates
      const p = window.portals[guid];
      const ll = p.getLatLng();
      if (existingType !== type) {
        thisPlugin.addPortalTHM(guid, ll.lat, ll.lng, p.options.data.title, type);
      }
    } else {
      // If portal isn't saved in THM: Add this POI

      // Get portal name and coordinates
      const portal = window.portals[guid];
      const latlng = portal.getLatLng();
      thisPlugin.addPortalTHM(guid, latlng.lat, latlng.lng, portal.options.data.title, type);
    }
  };

  // Add portal
  thisPlugin.addPortalTHM = function (guid, lat, lng, name, type) {
    // Add POI in the localStorage
    const obj = {'guid': guid, 'lat': lat, 'lng': lng, 'name': name};

    // prevent that it would trigger the missing portal detection if it's in our data
    if (window.portals[guid]) {
      obj.exists = true;
    }

    if (type == 'signalposts') {
      signalposts[guid] = obj;
    }
    if (type == 'raids') {
      raids[guid] = obj;
    }
    if (type == 'notthm') {
      notthm[guid] = obj;
    }

    thisPlugin.saveStorage();
    thisPlugin.updateStarPortal();

    thisPlugin.addStar(guid, lat, lng, name, type);
  };

  /*
    OPTIONS
  */
  // Manual import, export and reset data
  thisPlugin.thmActionsDialog = function () {
    const content = `<div id="thmSetbox">
      <a id="save-dialog" title="Select the data to save from the info on screen">Save...</a>
      <a onclick="window.plugin.thm.optReset();return false;" title="Deletes all THM markers">Reset THM portals</a>
      <a onclick="window.plugin.thm.optImport();return false;" title="Import a JSON file with all the THM data">Import THM</a>
      <a onclick="window.plugin.thm.optExport();return false;" title="Exports a JSON file with all the THM data">Export THM</a>
      <a onclick="window.plugin.thm.exportS2();return false;" title="Exports a JSON file with all the THM data">Export THM S2 L15</a>
      </div>`;

    const container = dialog({
      html: content,
      title: 'S2 & THM Actions'
    });

    const div = container[0];
    div.querySelector('#save-dialog').addEventListener('click', e => saveDialog());
  };

  function saveDialog() {
    const content = `<div>
      <p>Select the data to save from the info on screen</p>
      <fieldset><legend>Which data?</legend>
      <input type='radio' name='THMSaveDataType' value='SignalPosts' id='THMSaveDataTypeSignalposts'><label for='THMSaveDataTypeSignalposts'>Signal Posts</label><br>
      <input type='radio' name='THMSaveDataType' value='Raids' id='THMSaveDataTypeRaids'><label for='THMSaveDataTypeRaids'>Raids</label><br>
      <input type='radio' name='THMSaveDataType' value='All' id='THMSaveDataTypeAll'><label for='THMSaveDataTypeAll'>All</label>
      </fieldset>
      <fieldset><legend>Format</legend>
      <input type='radio' name='THMSaveDataFormat' value='CSV' id='THMSaveDataFormatCSV'><label for='THMSaveDataFormatCSV'>CSV</label><br>
      <input type='radio' name='THMSaveDataFormat' value='JSON' id='THMSaveDataFormatJSON'><label for='THMSaveDataFormatJSON'>JSON</label>
      </fieldset>
      <fieldset><legend>Wizards Unite Map</legend>
      <input type='checkbox' name='THMSaveForWUW' value='1' id='THMSaveForWUW'><label for='THMSaveForWUW'>Format for WUW Map</label>
      </fieldset>
      </div>`;

    function escapeCSV(s) {
      if (s === 0) {
        return '0';
      }
      if (s === undefined || s === null) {
        return '';
      }
      if (/[,"\n]/.test(s)) {
        return '"' + s.replace(/"/g, '""') + '"';
      }

      return s;
    }

    function mapToCSV(arr, type, wuw = false) {
        const data = filterItemsByMapBounds(arr);
        const keys = Object.keys(data);
        return keys.map(id => {
            const poi = data[id];
            return [poi.name, poi.lat, poi.lng, type].map(escapeCSV).join(',');
        });
    }

    const container = dialog({
      html: content,
      title: 'Save visible data',
      buttons: {
        'Save': function () {
          const SaveDataType = document.querySelector('input[name="THMSaveDataType"]:checked').value;
          const SaveDataFormat = document.querySelector('input[name="THMSaveDataFormat"]:checked').value;
          const SaveForWUW = !!document.querySelector('input[name="THMSaveForWUW"]').checked;
          const types = ['Raids', 'Signalposts', 'All'];
          if (types.indexOf(SaveDataType) < 0) {
            SaveDataType = 'All';
          }

          settings.saveDataType = SaveDataType;
          settings.saveDataFormat = SaveDataFormat;
          settings.saveForWUW = SaveForWUW;
          saveSettings();

          container.dialog('close');

          let filename = SaveDataType.toLowerCase() + '_' + (new Date()).toISOString().substr(0, 19).replace(/[\D]/g, '_');
          if (SaveDataFormat == 'CSV') {
            filename += '.csv';
            let rows = [];
            if (SaveForWUW) {
                rows.push('"Name","Latitude","Longitude","Type"');
            }
            if (SaveDataType == 'All' || SaveDataType == 'Signalposts') {
                rows = [...rows, ...mapToCSV(signalposts, 'signalpost', SaveForWUW)];
            }
            if (SaveDataType == 'All' || SaveDataType == 'Raids') {
                rows = [...rows, ...mapToCSV(raids, 'raid', SaveForWUW)];
            }

            saveToFile(rows.join('\n'), filename);
          } else {
            filename += '.json';
            let data = {};
            if (SaveDataType == 'All' || SaveDataType == 'Signalposts') {
              data.signalposts = filterItemsByMapBounds(signalposts);
            };
            if (SaveDataType == 'All' || SaveDataType == 'Raids') {
              data.raids = filterItemsByMapBounds(raids);
            };
            if (SaveForWUW) {
              let mapped = [];
              Object.keys(data).forEach(key => {
                mapped = [...mapped, ...Object.values(data[key]).map(poi => ({
                  name: poi.name,
                  latitude: poi.lat,
                  longitude: poi.lng,
                  type: key.slice(0, -1),
                }))];
              });
              data = mapped;
            } else {
              Object.keys(data).forEach(key => {
                data[key] = findPhotos(cleanUpExtraData(data[key]));
              });
            }

            saveToFile(JSON.stringify(data), filename);
          }
        }
      }

    });

    // Remove ok button
    const outer = container.parent();
    outer.find('.ui-dialog-buttonset button:first').remove();

    const div = container[0];
    div.querySelector('#THMSaveDataType' + settings.saveDataType).checked = true;
    div.querySelector('#THMSaveDataFormat' + settings.saveDataFormat).checked = true;
    div.querySelector('#THMSaveForWUW').checked = !!settings.saveForWUW;

  };

  thisPlugin.optAlert = function (message) {
    $('.ui-dialog .ui-dialog-buttonset').prepend('<p class="thm-alert" style="float:left;margin-top:4px;">' + message + '</p>');
    $('.thm-alert').delay(2500).fadeOut();
  };

  thisPlugin.optExport = function () {
    saveToFile(localStorage[KEY_STORAGE], 'IITC-thm.json');
  };

  thisPlugin.exportS2 = function () {
    const cells = groupByCell(15);
    const filtered = {};
    Object.keys(cells).forEach(cellId => {
      const cellData = cells[cellId];
      const cell = cellData.cell;

      if (cellData.signalposts.length || cellData.raids.length) {
        delete cellData.notClassified;
        delete cellData.notTHM;
        filtered[cellId] = cellData;
      }
    });

    saveToFile(filtered, 'IITC-thm-s2.json');
  };

  thisPlugin.optImport = function () {
    readFromFile(function (content) {
      try {
        const list = JSON.parse(content); // try to parse JSON first
        Object.keys(list).forEach(type => {
          for (let idthm in list[type]) {
            const item = list[type][idthm];
            const lat = item.lat;
            const lng = item.lng;
            const name = item.name;
            let guid = item.guid;
            if (!guid) {
              guid = findPortalGuidByPositionE6(lat * 1E6, lng * 1E6);
              if (!guid) {
                console.log('portal guid not found', name, lat, lng); // eslint-disable-line no-console
                guid = idthm;
              }
            }

            if (typeof lat !== "undefined" && typeof lng !== "undefined" && name && !thisPlugin.findByGuid(guid)) {
              thisPlugin.addPortalTHM(guid, lat, lng, name, type);
            }
          }
        });

        thisPlugin.updateStarPortal();
        thisPlugin.resetAllMarkers();
        thisPlugin.optAlert('Successful.');
      } catch (e) {
        console.warn('THM: failed to import data: ' + e); // eslint-disable-line no-console
        thisPlugin.optAlert('<span style="color: #f88">Import failed </span>');
      }
    });
  };

  thisPlugin.optReset = function () {
    if (confirm('All THM data will be deleted. Are you sure?', '')) {
      delete localStorage[KEY_STORAGE];
      thisPlugin.createEmptyStorage();
      thisPlugin.updateStarPortal();
      thisPlugin.resetAllMarkers();
      thisPlugin.optAlert('Successful.');
    }
  };

  /* THM PORTALS LAYER */
  thisPlugin.addAllMarkers = function () {
    function iterateStore(store, type) {
      for (let idthm in store) {
        const item = store[idthm];
        thisPlugin.addStar(item.guid, item.lat, item.lng, item.name, type);
      }
    }

    iterateStore(signalposts, 'signalposts');
    iterateStore(raids, 'raids');
    iterateStore(notthm, 'notthm');
  };

  thisPlugin.resetAllMarkers = function () {
    for (let guid in raidLayers) {
      const starInLayer = raidLayers[guid];
      raidLayerGroup.removeLayer(starInLayer);
      delete raidLayers[guid];
    }
    for (let signalpostGuid in signalpostLayers) {
      const signalpostInLayer = signalpostLayers[signalpostGuid];
      signalpostLayerGroup.removeLayer(signalpostInLayer);
      delete signalpostLayers[signalpostGuid];
    }
    for (let notthmGuid in notthmLayers) {
      const notthmInLayer = notthmLayers[notthmGuid];
      notthmLayerGroup.removeLayer(notthmInLayer);
      delete notthmLayers[notthmGuid];
    }
    thisPlugin.addAllMarkers();
  };

  thisPlugin.addStar = function (guid, lat, lng, name, type) {
    let star;
    if (type === 'raids') {
      star = new L.Marker.SVGMarker([lat, lng], {
        title: name,
        iconOptions: {
          className: 'raid',
          html: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 163.3 410.6"><path class="raid-base" d="M113.8 351.9l6.6 13.9 1.7 18.8-11 12-60.8 2.5-12.4-3.5-12.3-14.8 2.8-22.7 5.4-2 37-4.2z"/><path class="raid-steps" d="M38.9 358c-.1 0-2.1 16.2 20.9 18.1 23 1.9 44.7-10.3 44.7-10.3l-33.7-13.9-31.9 6.1z"/><path class="raid-steps" d="M46.6 360.8s-.3 8.6 13.9 10.3c14.2 1.7 33.6-5.3 33.6-5.3"/><path class="raid-flag" d="M83.1 37.6l.4-25 21.1 5.7-21.3 4.3"/><path class="raid-wall" d="M119.4 185.3l-8 85.7-68.3 2.6-4.4-86z"/><path class="raid-roof" d="M83.1 37.6l44 145 6.3 10s-24.3 5.1-54.3 4.7C50 197 27.4 192 27.4 192l17.3-28.7L83.1 37.6z"/><path class="raid-window" d="M61.7 156.3l6.5-7.5 8.5 8.5v19.4H62.4z"/><g><path class="raid-wall raid-thin" d="M110.8 129.6l-3.3 20s4.8 21.3 14.5 26l9.2-46h-20.4z"/><path class="raid-roof raid-thin" d="M130.3 74.3l-25 55.3h31.3z"/><path class="raid-wall raid-thin" d="M148.1 120.6l-7.9 40.2h-15.4l8.5-41.6z"/><path class="raid-roof raid-thin" d="M150.1 77.6l-22 41.2 24.2 1.8z"/></g><g><path class="raid-flag" d="M25.1 138.1l-2.7-23 18.7 2.4-17.7 6.1"/><path class="raid-wall" d="M57.3 228.6l5.8 130.5-16.5 1.7-12.8-4.7-17.2-127.5 14.7 2.2z"/><path class="raid-roof" d="M16.6 228.6l-6.8-3 6.8-13.3 8.5-74.2 25.5 72 14.2 12-7.5 6.5-26 2.2z"/><path class="raid-window" d="M23.6 219.2l8.4 11.5v13.4l-8-.8-2.7-14z"/></g><g><path class="raid-wall" d="M58.8 361.6l21 2 8.3-4.3 4-95.2-14.5 4.7-27.3-4.7z"/><path class="raid-door" d="M64.8 362.1s-.6-22.2 5.7-21.7c7.1.6 6.2 22.8 6.2 22.8l-11.9-1.1z"/><path class="raid-roof" d="M47.5 263.6l20.6-53.8 26.3 53.5-16.8 5.5z"/><path class="raid-window" d="M59.1 265.4l5.9-6.3 5.9 8.5-1.3 15.1H59.1z"/></g><g><path class="raid-flag" d="M122.1 172.1l2.8-21.6 21 7.8-22.1.3"/><path class="raid-wall" d="M111.6 365.8l17.5-108-23.8 2.5-15.2-2.5-5 103 9 5z"/><path class="raid-roof" d="M90.1 257.8l15.2 2.5 23.8-2.5 7.5-6.5-6.3-11.7-8.2-67.5-28.3 68.5-8.7 11.2z"/><path class="raid-window" d="M111.1 259.7l9.1-10.3 3.4 9-3.8 15.9h-8.7z"/></g></svg>`,
          iconSize: L.point(24, 62),
          iconAnchor: [11, 54]
        }
      });

    }
    if (type === 'signalposts') {
      const className = 'signalpost';
      star = new L.Marker.SVGMarker([lat, lng], {
        title: name,
        iconOptions: {
          id: 'signalpost' + guid.replace('.', ''),
          className: className,
          html: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 310 425.3"><path class="signalpost-wall" d="M63.3 395l-13.2-99.2L169.8 94l73.3 116.5 4 102.3-4 89.7-25 15.8-127-5.3z"/><path class="signalpost-door" d="M153.7 413v-64s2-17.3 27.7-16.3 27.3 19 27.3 19l1.7 63.3-56.7-2z"/><path class="signalpost-window" d="M88.8 338l37.5-2.5 4.4 59.7-39.4-2z"/><path class="signalpost-roof" d="M121 76.7L8 53l15 135L8 293.3 53.3 311l67 2 38.7-92.3 14-95L211.3 227l24.4 87.7 65.6-10.6L281 187.3 285 50l-71.3 22.3z"/><g class="signalpost-tower"><path class="signalpost-roof" d="M91 7.3L57.3 54.8l2 50.7 58.1 11 7.9-59.8z"/><path class="signalpost-window" d="M75.1 65.1h28L100.3 93l-23.7-1.7z"/></g></svg>`,
          iconSize: L.point(24, 32),
          iconAnchor: [12, 26]
        }
      });
    }

    if (type === 'notthm') {
      star = new L.Marker.SVGMarker([lat, lng], {
        title: name,
        iconOptions: {
          className: 'notthm',
          html: '<span>N/A</span>',
          iconSize: L.point(24, 24),
          iconAnchor: [12, 12]
        }
      });
    }

    if (!star)
      return;

    window.registerMarkerForOMS(star);
    star.on('spiderfiedclick', function () {
      // don't try to render fake portals
      if (guid.indexOf('.') > -1) {
        renderPortalDetails(guid);
      }
    });

    if (type === 'raids') {
      raidLayers[guid] = star;
      star.addTo(raidLayerGroup);
    }
    if (type === 'signalposts') {
      signalpostLayers[guid] = star;
      star.addTo(signalpostLayerGroup);
    }
    if (type === 'notthm') {
      notthmLayers[guid] = star;
      star.addTo(notthmLayerGroup);
    }
  };

  thisPlugin.setupCSS = function () {
    $('<style>').prop('type', 'text/css').html(`
#sidebar #portaldetails h3.title{
  width:auto;
}
.thmRaid span,
.thmSignalpost span {
  display:inline-block;
  float:left;
  margin:3px 1px 0 4px;
  width:24px;
  height:24px;
  overflow:hidden;
  background-repeat:no-repeat;
  background-size:contain;
}
.thmRaid span,
.thmSignalpost span {
  filter:grayscale(100%);
}
.thmRaid:focus span, .thmRaid.favorite span,
.thmSignalpost:focus span, .thmSignalpost.favorite span {
  filter:none;
}

/**********************************************
  DIALOG BOX
**********************************************/

/*---- Options panel -----*/
#thmSetbox a{
  display:block;
  color:#ffce00;
  border:1px solid #ffce00;
  padding:3px 0;
  margin:10px auto;
  width:80%;
  text-align:center;
  background:rgba(8,48,78,.9);
}
#thmSetbox a.disabled,
#thmSetbox a.disabled:hover{
  color:#666;
  border-color:#666;
  text-decoration:none;
}

#thmSetbox{
  text-align:center;
}
.thmRaid span {
  background-image:url(data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAMAAADXqc3KAAABoVBMVEUAAADBu67BvK8Ae8Xm4tHc18etp5jl4NDBvK2nmo7h3MxoUknf3Mu1r6DAvK/l4dDRzb7Bu6/LxLXo4dLWzsDm4tPj3s8wKzq/v6/o4taxpJgAgNP/ABPRxroAgc/d2cm5s6PWz8Hd2cnMxrfxAAoAidsAdrzc1ca5s6QAkecAcbTm4dBPo9RGns5GqeBClsQ+jrk4ha7BvK65s6Po49O2saHl4NG5s6Pp5NS3sKGeDhfX0cPMx7bl39C5s6TV0MCyrJ4EecAEdLfl4NC6s6S3r6Pn5NPwAAmsppe4sqUAl/UAb67l4c8Ai9oAdLy4sKHIw7S3sqPuAAsAjeQAcrXp4dK8tKX/AAyUDRskJEnBvK/c1sfo49Pl4NDTzr/HwrPJw7bg28vNx7nGwLLAuqy8tqnZ08TQyru+uKvVz8DBu624saTa1MXX0cLDvbG/uaq3sKNfRj3i3c7h3M3f2sve2Mnl4dEAgc/LxbbBvbDDuau7tKe8sKOknpacl5OnmYyLhoV7dndVUVoAidvRy7wAdrytqKGmn5dmYWdjXmS2CA7KjyJJAAAAWnRSTlMAUOn+7T029+vr6eXd1tDCooBXUTczMjAgFRURDQv7+vj28vDv7u7o3dnZ0sjFxMTExMLAs7OlpJWVkYyMiId+fnZ1bGtZVlZTT0xMRURERDMxLiYmIiIVEwd4pmW4AAABgUlEQVQoz3XQZVdjMRAG4JS2iy/O7sKyLri7u7szuUmu9kqNGu4Ov5opX+CclvdTzjxnJsmQN9nZXv1K0uXT0593oHdqKy2MjJK0WfjmXkxXX/u77/63nlqvrLned9/WVqbAbGN9Q1Nzy1xqi5SIBsD/pjA06eqf+IAg2YEDBG9xn6t4GKHuV87PrGlCgtLFhbxLSIkn8//vfIT2WNQMv3Q8PCahLBG3RQdCt8Rtp4IQym5kDeGLxOhBD8J8gJqtrs8uGg1wcYyHgnhQLCGU+HxaVsbHDE3WQiEHDznUdGYQxhSfqusWJGMA6NZ3zsU4woBPVR0Ay4LLyySFGFX1QYRO5erU0AG4fHYmcwDB7q5EF0KBcu93DANoTFIYBUNmoVPRhpAXxDtweEw6OtqjACajXK9GyFRsOXwMh/GTSOREOgTOTC5+4H+YYqphv6XtnUci5wnNCtqUi90KUsbwueH8okJPdm5utqewKA9HaX7c0Ua5t3Sl6nXbVeWl3uVN8gwRMmy+jlYyqwAAAABJRU5ErkJggg==);
}
.thmSignalpost span {
  background-image:url(data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAMAAADXqc3KAAABX1BMVEUAAAD/AADn6u98tB7/AA7/AA69yc3P19twgIeYaUp2eIB/uCKix2qryId4th97rR5djGJ6tR34AA2qh2qllGmff2x1eoOwlISFviuzxrThAQp5tR24xsCLvz/G2rOjxne0zJ5tgIm8z7N6tB+VY2NqgIrm6+//AA5OzuaebEnUy8V7th2Zc168s7C2nI2XaEmchm52nZeKhXGDvSXhAQrc4eb3AA3j6Ozf5urY3OHb3eDg2tzV09fWz8tdvMnK3bh7iHuigWWkfmGSel+SblTwR1H1LjqHvyn+CBbYAwjh5urf6OPY2d3R2Nzi1NrY5dXZ09DCxcvixMrQ4cPhvMPR4sDiq7Hjo6qpqaSsxKFxoqC71pu70JjkkJeFj5flh4+x0YimxYZ8j4Xle4SvyYKwmYLpbHSCemmawmXrWWOFcF3tUl2XdVe8qFaeclTxPUjzN0L5Hir7GSbkAQvWBAcsCSLkAAAAJnRSTlMAB2BEs7nAQED+8f7jcyEMBfvz8vLx7Ojm4NTSz7J1Z19UUEskGInQITEAAAEXSURBVCjPbczlUsNAFIbhbEuApIq7w1lSAilE6q64u7s79z/sph02KXlm9s/3zh7OAiHOEWrikfOOMSu2vVwmJdhKTNn2j2TyHfOT3aIojln30gpArIT5fk1btO7POhD6I26nge13UTBFr7Hx88328wjURU6xof3t+2Cxhw1U26s7YLNV5RHdv9agQeKTFs4FiRCxATqkQlQKXGSmYe4pm72XV8/03DyVY+EqnT6SN19j4WkqzEKxUHiRlw7gX1AkSZIBnMJbkYb8ApW3/VBIiM/WxBtOMfVwcmuGG4Dl7d3M+nHmYpjuwaHOHkUQhK4Or9ejqpWKqqq9ExznH3g4HGym+i5nTB7y2vxcwD3iG2+hRn1uJvAL1ThByGyKR5AAAAAASUVORK5CYII=);
}

.THMButtons {
  color: #fff;
  padding: 3px;
}

.THMButtons span {
  float: none;
}

.notTHM span {
    color: #FFF;
    background: #000;
    border-radius: 50%;
    font-size: 10px;
    letter-spacing: -0.15em;
    display: inline-block;
    opacity: 0.6;
    margin: 3px 1px 0 2px;
    height: 24px;
    width: 24px;
    box-sizing: border-box;
}

.notTHM span:after {
    display: inline-block;
    content: "N/A";
    position: absolute;
    width: 24px;
    line-height: 24px;
    text-align: center;
    vertical-align: middle;
}

.notTHM:focus span, .notTHM.favorite span {
  opacity: 1;
}

.s2check-text {
  text-align: center;
  font-weight: bold;
  border: none !important;
  background: none !important;
  font-size: 130%;
  color: #000;
  text-shadow: 1px 1px #FFF, 2px 2px 6px #fff, -1px -1px #fff, -2px -2px 6px #fff;
}

#THMSignalpostInfo {
  display: none;
    padding: 3px;
}

.isSignalpost #THMSignalpostInfo {
  display: block;
}

.thisIsTHM .layer_off_warning,
.thisIsTHM .mods,
.thisIsTHM #randdetails,
.thisIsTHM #resodetails,
.thisIsTHM #level {
    display: none;
}

.thisIsTHM #playerstat,
.thisIsTHM #gamestat,
.thisIsTHM #redeem,
.thisIsTHM #chat,
.thisIsTHM #artifactLink,
.thisIsTHM #scoresLink,
.thisIsTHM #chatinput,
.thisIsTHM #chatcontrols {
    display: none;
}

.thisIsTHM #mobileinfo .portallevel,
.thisIsTHM #mobileinfo .resonator {
    display: none;
}

.thisIsTHM #sidebar #portaldetails h3.title {
  color: #fff;
}

.signalpost {
    opacity: 0.8;
    stroke: #888;
}

.signalpost-wall{fill:#ddd;stroke-width:8;}
.signalpost-door{fill:#534C39;stroke-width:8;}
.signalpost-window{fill:#EBC360;stroke-width:4;}
.signalpost-roof{fill:#ddd;stroke-width:10;}
.signalpost-tower .signalpost-roof{stroke-width:5;}

.GreenColor {
  stroke: #4b474a;
}
.GreenColor .signalpost-wall {
  fill: #6a686f;
}
.GreenColor .signalpost-roof {
  fill: #59672e;
}

.PinkColor {
  stroke: #61646b;
}
.PinkColor .signalpost-wall {
  fill: #5b306f;
}
.PinkColor .signalpost-roof {
  fill: #1c6775;
}

.BlueColor {
  stroke: #45527c;
}
.BlueColor .signalpost-wall {
  fill: #868692;
}
.BlueColor .signalpost-roof {
  fill: #4162a9;
}

.BrownColor {
  stroke: #5b5c5e;
}
.BrownColor .signalpost-wall {
  fill: #6a7d7f;
}
.BrownColor .signalpost-roof {
  fill: #6b4a2e;
}

.PurpleColor {
  stroke: #47408e;
}
.PurpleColor .signalpost-wall {
  fill: #758093;
}
.PurpleColor .signalpost-roof {
  fill: #664b77;
}

.WhiteColor {
  stroke: #312c27;
}
.WhiteColor .signalpost-wall {
  fill: #b4b1a9;
}
.WhiteColor .signalpost-roof {
  fill: #2f4c58;
}

.smallsignalposts .signalpost {
    opacity: 0.9;
}

.smallsignalposts .signalpost svg {
  transform: scale(0.8);
}

.s2score {
  color: red;
  opacity: 0.8;
  background-color: #fff;
  border-radius: 50%;
  box-sizing: border-box;
  text-align: center;
  line-height: 40px;
  vertical-align: middle;
}

.notthm {
  opacity: 0.9;
  color: #fff;
  background-color: #ccc;
  border: solid 1px #aaa;
  border-radius: 50%;
  box-sizing: border-box;
  line-height: 22px;
  vertical-align: middle;
  text-align: center;
  font-size: 10px;
}

.raid {
  stroke:#373F4E;
}
.raid-base{fill:#68655E;stroke-width:8;}
.raid-steps{fill:#BDB9AD;stroke-width:2;}
.raid-flag{fill:#CB5E35;stroke-width:2;}
.raid-wall{fill:#8D7F65;stroke-width:6;}
.raid-roof{fill:#D3867C;stroke-width:6;}
.raid-window{fill:#FAE792;stroke-width:2;}
.raid-thin{stroke-width:4;}
.raid-door{fill:#62463A;stroke-width:2;}


.THMClassification div {
    display: grid;
    grid-template-columns: 200px 70px 90px 35px;
    text-align: center;
    align-items: center;
    height: 140px;
    overflow: hidden;
  margin-bottom: 10px;
}

.THMClassification div:nth-child(odd) {
  background: rgba(7, 42, 69, 0.9);
}

.THMClassification img {
    max-width: 200px;
  max-height: 140px;
    display: block;
    margin: 0 auto;
}

#dialog-missingPortals .THMClassification div {
  height: 50px;
}

img.photo,
.ingressLocation,
.thmLocation {
    cursor: zoom-in;
}

.THM-PortalAnimation {
  width: 30px;
  height: 30px;
  background-color: rgba(255, 255, 255, 0.5);
  border-radius: 50%;
  box-shadow: 0px 0px 4px white;
  animation-duration: 1s;
  animation-name: shrink;
}

@keyframes shrink {
  from {
    width: 30px;
    height: 30px;
    top: 0px;
    left: 0px;
  }

  to {
    width: 10px;
    height: 10px;
    top: 10px;
    left: 10px;
  }
}

.THM-PortalAnimationHover {
  background-color: rgb(255, 102, 0, 0.8);
  border-radius: 50%;
  animation-duration: 1s;
  animation-name: shrinkHover;
  animation-iteration-count: infinite;
}

@keyframes shrinkHover {
  from {
    width: 40px;
    height: 40px;
    top: 0px;
    left: 0px;
  }

  to {
    width: 20px;
    height: 20px;
    top: 10px;
    left: 10px;
  }
}

#sidebarTHM {
    color: #eee;
    padding: 2px 5px;
}

#sidebarTHM span {
    margin-right: 5px;
}

.refreshingData,
.refreshingPortalCount {
    opacity: 0.5;
  pointer-events: none;
}

#sidebarTHM.mobile {
    width: 100%;
    background: rebeccapurple;
    display: flex;
}

#sidebarTHM.mobile > div {
    margin-right: 1em;
}

.thm-colors input[type=color] {
  border: 0;
  padding: 0;
}

`).appendTo('head');
  };

  // A portal has been received.
  function onPortalAdded(data) {
    const guid = data.portal.options.guid;

    data.portal.on('add', function () {
      addNearbyCircle(guid);
    });

    data.portal.on('remove', function () {
      removeNearbyCircle(guid);
    });

    // analyze each portal only once, but sometimes the first time there's no additional data of the portal
    if (allPortals[guid] && allPortals[guid].name)
      return;

    const portal = {
      guid: guid,
      name: data.portal.options.data.title,
      lat: data.portal._latlng.lat,
      lng: data.portal._latlng.lng,
      image: data.portal.options.data.image,
      cells: {}
    };

    allPortals[guid] = portal;

    // If it's already classified in THM, get out
    const thmData = thisPlugin.findByGuid(guid);
    if (thmData) {
      const thmItem = thmData.store[guid];
      if (!thmItem.exists) {
        // Mark that it still exists in Ingress
        thmItem.exists = true;

        if (missingPortals[guid]) {
          delete missingPortals[guid];
          updateMissingPortalsCount();
        }

        // Check if it has been moved
        if (thmItem.lat != portal.lat || thmItem.lng != portal.lng) {
          movedPortals.push({
            thm: thmItem,
            ingress: portal
          });
          updateCounter('moved', movedPortals);
        }
      }
      if (!thmItem.name && portal.name) {
        thmData.store[guid].name = portal.name;
      }
      return;
    }

    if (skippedPortals[guid]/* || newPokestops[guid]*/)
      return;

    newPortals[guid] = portal;

    refreshNewPortalsCounter();
    //updateMapGrid();
  }

  /**
   * Draw a 20m circle around a portal
   */
  function addNearbyCircle(guid) {
    const portal = window.portals[guid];
    if (!portal)
      return;

    const circleSettings = {
      color: settings.colors.nearbyCircleBorder.color,
      opacity: settings.colors.nearbyCircleBorder.opacity,
      fillColor: settings.colors.nearbyCircleFill.color,
      fillOpacity: settings.colors.nearbyCircleFill.opacity,
      weight: 1,
      clickable: false,
      interactive: false
    };

    const center = portal._latlng;
    const circle = L.circle(center, 20, circleSettings);
    nearbyGroupLayer.addLayer(circle);
    nearbyCircles[guid] = circle;
  }

  /**
   * Removes the 20m circle if a portal is purged
   */
  function removeNearbyCircle(guid) {
    const circle = nearbyCircles[guid];
    if (circle != null) {
      nearbyGroupLayer.removeLayer(circle);
      delete nearbyCircles[guid];
    }
  }

  function redrawNearbyCircles() {
    const keys = Object.keys(nearbyCircles);
    keys.forEach(guid => {
      removeNearbyCircle(guid);
      addNearbyCircle(guid);
    });
  }

  function refreshNewPortalsCounter() {
    if (!settings.analyzeForMissingData)
      return;

    // workaround for https://bugs.chromium.org/p/chromium/issues/detail?id=961199
    try
    {
      if (checkNewPortalsTimout) {
        clearTimeout(checkNewPortalsTimout);
      } else {
        document.getElementById('sidebarTHM').classList.add('refreshingPortalCount');
      }
    } catch (e) {
      // nothing
    }

    // workaround for https://bugs.chromium.org/p/chromium/issues/detail?id=961199
    try
    {
      checkNewPortalsTimout = setTimeout(checkNewPortals, 1000);
    } catch (e) {
      checkNewPortals();
    }
  }

  /**
   * A potential new portal has been received
   */
  function checkNewPortals() {
    checkNewPortalsTimout = null;

    // don't try to classify if we don't have all the portal data
    if (map.getZoom() < 15)
      return;

    document.getElementById('sidebarTHM').classList.remove('refreshingPortalCount');

    // newPokestops = {};
    notClassifiedPois = [];

    const allCells = groupByCell(17);

    // Check only the items inside the screen,
    // the server might provide info about remote portals if they are part of a link
    // and we don't know anything else about nearby portals of that one.
    // In this case (vs drawing) we want to filter only cells fully within the screen
    const cells = filterWithinScreen(allCells);

    // try to guess new pois if they are the only items in a cell
    Object.keys(cells).forEach(id => {
      const data = allCells[id];
      checkIsPortalMissing(data.signalposts, data);
      checkIsPortalMissing(data.raids, data);

      if (data.notClassified.length == 0)
        return;
      const notClassified = data.notClassified;

      if (data.signalposts.length || data.raids.length) {
        // Already has a thm item, ignore the rest
        notClassified.forEach(portal => {
          skippedPortals[portal.guid] = true;
          delete newPortals[portal.guid];
        });
        return;
      }

      // too many items to guess
      notClassifiedPois.push(data.notClassified);
    });

    updateCounter('classification', notClassifiedPois);
    updateMissingPortalsCount();
  }

  /**
   * Filter the missing portals detection to show only those on screen and reduce false positives
   */
  function updateMissingPortalsCount() {
    const keys = Object.keys(missingPortals);
    if (keys.length == 0)
      updateCounter('missing', []);

    const bounds = map.getBounds();
    const filtered = [];
    keys.forEach(guid => {
      const thmData = thisPlugin.findByGuid(guid);
      const item = thmData.store[guid];
      if (isPointOnScreen(bounds, item)) {
        filtered.push(item);
      }
    });
    updateCounter('missing', filtered);
  }

  /**
   * Given an array of THM items checks if they have been removed from Ingress
   */
  function checkIsPortalMissing(array, cellData) {
    array.forEach(item => {
      if (item.exists || item.newGuid)
        return;
      const guid = item.guid;

      if (findCorrectGuid(item, cellData.notClassified)) {
        return;
      }
      if (!missingPortals[guid]) {
        missingPortals[guid] = true;
      }
    });
  }

  /**
   * Check if there's another real portal in the same cell (we're checking a poi that doesn't exist in Ingress)
   */
  function findCorrectGuid(thmItem, array) {
    const portal = array.find(x => x.name == thmItem.name && x.guid != thmItem.guid);
    if (portal != null) {
      thmItem.newGuid = portal.guid;
      movedPortals.push({
        thm: thmItem,
        ingress: portal
      });
      updateCounter('moved', movedPortals);

      delete missingPortals[thmItem.guid];

      return true;
    }
    return false;
  }

  function getCellScores() {
    const allCells = groupByCell(15);
    const cells = filterWithinScreen(allCells);

    const cellIndex = {};
    Object.keys(cells).forEach(id => {
      const cell = allCells[id];
      cellIndex[cell.cell] = cell;
    });

    return cellIndex;
  }

  /**
   * In a level 16 cell there's more than one portal, ask which one is Signal Post or Raid
   */
  function promptToClassifyPois() {
    updateCounter('classification', notClassifiedPois);
    if (notClassifiedPois.length == 0)
      return;

    const group = notClassifiedPois.shift();
    const div = document.createElement('div');
    div.className = 'THMClassification';
    group.sort(sortByName).forEach(portal => {
      const wrapper = document.createElement('div');
      wrapper.setAttribute('data-guid', portal.guid);
      const img = getPortalImage(portal);
      wrapper.innerHTML = '<span class="THMName">' + getPortalName(portal) +
        img + '</span>' +
        '<a data-type="raids">' + 'RAID' + '</a> ' +
        '<a data-type="signalposts">' + 'SIGNALPOST' + '</a>';
      div.appendChild(wrapper);
    });
    const container = dialog({
      id: 'classifyPoi',
      html: div,
      width: '420px',
      title: 'Which one is in THM?',
      buttons: {
        // Button to allow skip this cell
        Skip: function () {
          container.dialog('close');
          group.forEach(portal => {
            delete newPortals[portal.guid];
            skippedPortals[portal.guid] = true;
          });
          // continue
          promptToClassifyPois();
        }
      }
    });
    // Remove ok button
    const outer = container.parent();
    outer.find('.ui-dialog-buttonset button:first').remove();

    // mark the selected one as signal post or raid
    container.on('click', 'a', function (e) {
      const type = this.getAttribute('data-type');
      const guid = this.parentNode.getAttribute('data-guid');
      const portal = getPortalSummaryFromGuid(guid);
      thisPlugin.addPortalTHM(guid, portal.lat, portal.lng, portal.name, type);

      group.forEach(tmpPortal => {
        delete newPortals[tmpPortal.guid];
      });

      container.dialog('close');
      // continue
      promptToClassifyPois();
    });
    container.on('click', 'img.photo', centerPortal);
    configureHoverMarker(container);
  }

  /**
   * List of portals that have been moved
   */
  function promptToMovePois() {
    if (movedPortals.length == 0)
      return;

    const div = document.createElement('div');
    div.className = 'THMClassification';
    movedPortals.sort(sortByName).forEach(pair => {
      const portal = pair.ingress;
      const thmItem = pair.thm;
      const wrapper = document.createElement('div');
      wrapper.setAttribute('data-guid', portal.guid);
      wrapper.dataPortal = portal;
      wrapper.datTHMGuid = thmItem.guid;
      const img = getPortalImage(portal);
      wrapper.innerHTML = '<span class="THMName">' + getPortalName(portal) +
        img + '</span>' +
        '<span><span class="ingressLocation">' + 'Ingress location' + '</span></span>' +
        '<span><span class="thmLocation" data-lat="' + thmItem.lat + '" data-lng="' + thmItem.lng + '">' + 'THM location' + '</span><br>' +
        '<a>' + 'Update' + '</a></span>';
      div.appendChild(wrapper);
    });
    const container = dialog({
      id: 'movedPortals',
      html: div,
      width: '420px',
      title: 'These portals have been moved in Ingress',
      buttons: {
        // Button to move all the portals at once
        'Update all': function () {
          container.dialog('close');
          movedPortals.forEach(pair => {
            const portal = pair.ingress;
            const thmItem = pair.thm;
            moveTHM(portal, thmItem.guid);
          });
          movedPortals.length = 0;
          updateCounter('moved', movedPortals);

          thisPlugin.saveStorage();
        }
      }
    });

    // Update location
    container.on('click', 'a', function (e) {
      const row = this.parentNode.parentNode;
      const portal = row.dataPortal;
      moveTHM(portal, row.dataTHMGuid);

      thisPlugin.saveStorage();
      if (settings.highlightTHMCandidateCells) {
        updateMapGrid();
      }

      $(row).fadeOut(200);

      // remove it from the list of portals
      const idx = movedPortals.findIndex(pair => pair.ingress.guid == pair.ingress.guid);
      movedPortals.splice(idx, 1);
      updateCounter('moved', movedPortals);

      if (movedPortals.length == 0)
        container.dialog('close');
    });
    container.on('click', 'img.photo', centerPortal);
    container.on('click', '.ingressLocation', centerPortal);
    container.on('click', '.thmLocation', centerPortalAlt);
    configureHoverMarker(container);
    configureHoverMarkerAlt(container);
  }

  /**
   * Update location of a THM item
   */
  function moveTHM(portal, thmGuid) {
    const guid = portal.guid;
    const thmData = thisPlugin.findByGuid(thmGuid);

    const existingType = thmData.type;
    // remove marker
    removeTHMObject(existingType, guid);

    // Draw new marker
    thisPlugin.addPortalTHM(guid, portal.lat, portal.lng, portal.name || thmData.name, existingType);
  }

  /**
   * THM items that aren't in Ingress
   */
  function promptToRemovePois(missing) {
    const div = document.createElement('div');
    div.className = 'THMClassification';
    missing.sort(sortByName).forEach(portal => {
      const wrapper = document.createElement('div');
      wrapper.setAttribute('data-guid', portal.guid);
      const name = portal.name || 'Unknown';
      wrapper.innerHTML = '<span class="THMName"><span class="thmLocation" data-lat="' + portal.lat + '" data-lng="' + portal.lng + '">' + name + '</span></span>' +
        '<span><a>' + 'Remove' + '</a></span>';
      div.appendChild(wrapper);
    });
    const container = dialog({
      id: 'missingPortals',
      html: div,
      width: '420px',
      title: 'These portals are missing in Ingress',
      buttons: {
      }
    });

    // Update location
    container.on('click', 'a', function (e) {
      const row = this.parentNode.parentNode;
      const guid = row.getAttribute('data-guid');
      const thmData = thisPlugin.findByGuid(guid);
      const existingType = thmData.type;

      // remove marker
      removeTHMObject(existingType, guid);
      thisPlugin.saveStorage();

      $(row).fadeOut(200);

      delete missingPortals[guid];
      updateMissingPortalsCount();

      if (Object.keys(missingPortals).length == 0) {
        container.dialog('close');
      }
    });
    container.on('click', '.thmLocation', centerPortalAlt);
    configureHoverMarkerAlt(container);
  }

  function configureHoverMarker(container) {
    let hoverMarker;
    container.find('img.photo, .ingressLocation').hover(
      function hIn() {
        const row = this.parentNode.parentNode;
        const guid = row.getAttribute('data-guid');
        const portal = row.dataPortal || window.portals[guid];
        if (!portal)
          return;
        const center = portal._latlng || new L.LatLng(portal.lat, portal.lng);
        hoverMarker = L.marker(center, {
          icon: L.divIcon({
            className: 'THM-PortalAnimationHover',
            iconSize: [40, 40],
            iconAnchor: [20, 20],
            html: ''
          }),
          interactive: false
        });
        map.addLayer(hoverMarker);
      }, function hOut() {
        if (hoverMarker)
          map.removeLayer(hoverMarker);
      });
  }

  function configureHoverMarkerAlt(container) {
    let hoverMarker;
    container.find('.thmLocation').hover(
      function hIn() {
        const lat = this.getAttribute('data-lat');
        const lng = this.getAttribute('data-lng');
        const center = new L.LatLng(lat, lng);
        hoverMarker = L.marker(center, {
          icon: L.divIcon({
            className: 'THM-PortalAnimationHover',
            iconSize: [40, 40],
            iconAnchor: [20, 20],
            html: ''
          }),
          interactive: false
        });
        map.addLayer(hoverMarker);
      }, function hOut() {
        if (hoverMarker)
          map.removeLayer(hoverMarker);
      });
  }

  /**
   * Center the map on the clicked portal to help tracking it (the user will have to manually move the dialog)
   */
  function centerPortal(e) {
    const row = this.parentNode.parentNode;
    const guid = row.getAttribute('data-guid');
    const portal = row.dataPortal || window.portals[guid];
    if (!portal)
      return;
    const center = portal._latlng || new L.LatLng(portal.lat, portal.lng);
    map.panTo(center);
    drawClickAnimation(center);
  }

  function centerPortalAlt(e) {
    const lat = this.getAttribute('data-lat');
    const lng = this.getAttribute('data-lng');
    const center = new L.LatLng(lat, lng);
    map.panTo(center);
    drawClickAnimation(center);
  }

  function drawClickAnimation(center) {
    const marker = L.marker(center, {
      icon: L.divIcon({
        className: 'THM-PortalAnimation',
        iconSize: [30, 30],
        iconAnchor: [15, 15],
        html: ''
      }),
      interactive: false
    });
    map.addLayer(marker);

    setTimeout(function () {
      map.removeLayer(marker);
    }, 2000);
  }

  function getPortalSummaryFromGuid(guid) {
    const newPortal = newPortals[guid];
    if (newPortal)
      return newPortal;

    const portal = window.portals[guid];
    if (!portal)
      return {};

    return {
      guid: guid,
      name: portal.options.data.title,
      lat: portal._latlng.lat,
      lng: portal._latlng.lng,
      image: portal.options.data.image,
      cells: {}
    };
  }

  function getPortalImage(poi) {
    if (poi.image)
      return '<img src="' + poi.image.replace('http:', 'https:') + '" class="photo">';

    const portal = window.portals[poi.guid];
    if (!portal)
      return '';

    if (portal && portal.options && portal.options.data && portal.options.data.image) {
      poi.image = portal.options.data.image;
      return '<img src="' + poi.image.replace('http:', 'https:') + '" class="photo">';
    }
    return '';
  }

  function getPortalName(poi) {
    if (poi.name)
      return poi.name;

    const portal = window.portals[poi.guid];
    if (!portal)
      return '';

    if (portal && portal.options && portal.options.data && portal.options.data.title) {
      poi.name = portal.options.data.title;
      return poi.name;
    }
    return '';
  }

  function removeLayer(name) {
    const layers = window.layerChooser._layers;
    const layersIds = Object.keys(layers);

    let layerId = null;
    let leafletLayer;
    let isBase;
    let arrayIdx;
    layersIds.forEach(id => {
      const layer = layers[id];
      if (layer.name == name) {
        leafletLayer = layer.layer;
        layerId = leafletLayer._leaflet_id;
        isBase = !layer.overlay;
        arrayIdx = id;
      }
    });

    // The Beacons and Frackers are not there in Firefox, why????
    if (!leafletLayer) {
      return;
    }

    const enabled = map._layers[layerId] != null;
    if (enabled) {
      // Don't remove base layer if it's used
      if (isBase)
        return;

      map.removeLayer(leafletLayer);
    }
    if (typeof leafletLayer.off != 'undefined')
      leafletLayer.off();

    // new Leaflet
    if (Array.isArray(layers)) {
      // remove from array
      layers.splice(parseInt(arrayIdx, 10), 1);
    } else {
      // classic IITC, leaflet 0.7.7
      // delete from object
      delete layers[layerId];
    }
    window.layerChooser._update();
    removedLayers[name] = {
      layer: leafletLayer,
      enabled: enabled,
      isBase: isBase
    };
    window.updateDisplayedLayerGroup(name, enabled);
  }
  const removedLayers = {};
  let portalsLayerGroup;

  function removeIngressLayers() {
    removeLayer('CartoDB Dark Matter');
    removeLayer('CartoDB Positron');
    removeLayer('Google Default Ingress Map');

    removeLayer('Fields');
    removeLayer('Links');
    removeLayer('DEBUG Data Tiles');
    removeLayer('Artifacts');
    removeLayer('Ornaments');
    removeLayer('Beacons');
    removeLayer('Frackers');

    removeLayer('Unclaimed/Placeholder Portals');
    for (let i = 1; i <= 8; i++) {
      removeLayer('Level ' + i + ' Portals');
    }
    //removeLayer('Resistance');
    //removeLayer('Enlightened');
    mergePortalLayers();
  }

  /**
   * Put all the layers for Ingress portals under a single one
   */
  function mergePortalLayers() {
    portalsLayerGroup = new L.LayerGroup();
    window.addLayerGroup('Ingress Portals', portalsLayerGroup, true);
    portalsLayerGroup.addLayer(removedLayers['Unclaimed/Placeholder Portals'].layer);
    for (let i = 1; i <= 8; i++) {
      portalsLayerGroup.addLayer(removedLayers['Level ' + i + ' Portals'].layer);
    }
    //portalsLayerGroup.addLayer(removedLayers['Resistance'].layer);
    //portalsLayerGroup.addLayer(removedLayers['Enlightened'].layer);
  }

  /**
   * Remove the single layer for all the portals
   */
  function revertPortalLayers() {
    if (!portalsLayerGroup) {
      return;
    }
    const name = 'Ingress Portals';
    const layerId = portalsLayerGroup._leaflet_id;
    const enabled = map._layers[layerId] != null;

    const layers = window.layerChooser._layers;
    if (Array.isArray(layers)) {
      // remove from array
      const idx = layers.findIndex(o => o.layer._leaflet_id == layerId);
      layers.splice(idx, 1);
    } else {
      // classic IITC, leaflet 0.7.7
      // delete from object
      delete layers[layerId];
    }
    window.layerChooser._update();
    window.updateDisplayedLayerGroup(name, enabled);

    if (typeof portalsLayerGroup.off != 'undefined')
      portalsLayerGroup.off();
    if (enabled) {
      map.removeLayer(portalsLayerGroup);
    }
    portalsLayerGroup = null;
  }

  function restoreIngressLayers() {
    revertPortalLayers();

    Object.keys(removedLayers).forEach(name => {
      const info = removedLayers[name];
      if (info.isBase)
        window.layerChooser.addBaseLayer(info.layer, name);
      else
        window.addLayerGroup(name, info.layer, info.enabled);
    });
  }

  function zoomListener() {
    const zoom = map.getZoom();
    document.body.classList.toggle('smallsignalposts', zoom < 16);
  }

  const setup = function () {
    thisPlugin.isSmart = window.isSmartphone();

    initSvgIcon();

    loadSettings();

    // Load data from localStorage
    thisPlugin.loadStorage();

    thisPlugin.htmlStar = `<a class="thmRaid" accesskey="f" onclick="window.plugin.thm.switchStarPortal('raids');return false;" title="Mark this portal as a raid [f]"><span></span></a>
      <a class="thmSignalpost" accesskey="i" onclick="window.plugin.thm.switchStarPortal('signalposts');return false;" title="Mark this portal as an Signal Post [i]"><span></span></a>
      <a class="notTHM" onclick="window.plugin.thm.switchStarPortal('notthm');return false;" title="Mark this portal as a removed/Not Available in THM"><span></span></a>
      `;

    thisPlugin.setupCSS();

    const sidebarTHM = document.createElement('div');
    sidebarTHM.id = 'sidebarTHM';
    sidebarTHM.style.display = 'none';
    if (thisPlugin.isSmart) {
      const status = document.getElementById('updatestatus');
      sidebarTHM.classList.add('mobile');
      status.insertBefore(sidebarTHM, status.firstElementChild);

      const dStatus = document.createElement('div');
      dStatus.className = 'THMStatus';
      status.insertBefore(dStatus, status.firstElementChild);
    } else {
      document.getElementById('sidebar').appendChild(sidebarTHM);
    }

    sidebarTHM.appendChild(createCounter('Review required', 'classification', promptToClassifyPois));
    sidebarTHM.appendChild(createCounter('Moved portals', 'moved', promptToMovePois));
    sidebarTHM.appendChild(createCounter('Missing portals', 'missing', promptToRemovePois));

    window.addHook('portalSelected', thisPlugin.onPortalSelected);

    window.addHook('portalAdded', onPortalAdded);
    window.addHook('mapDataRefreshStart', function () {
      sidebarTHM.classList.add('refreshingData');
    });
    window.addHook('mapDataRefreshEnd', function () {
      sidebarTHM.classList.remove('refreshingData');
      refreshNewPortalsCounter();
    });
    map.on('moveend', function () {
      refreshNewPortalsCounter();
    });
    sidebarTHM.classList.add('refreshingData');

    // Layer - THM portals
    raidLayerGroup = new L.LayerGroup();
    window.addLayerGroup('Raids', raidLayerGroup, true);
    signalpostLayerGroup = new L.LayerGroup();
    window.addLayerGroup('Signalposts', signalpostLayerGroup, true);
    notthmLayerGroup = new L.LayerGroup();
    window.addLayerGroup('N/A', notthmLayerGroup, false);
    regionLayer = L.layerGroup();
    window.addLayerGroup('S2 Grid', regionLayer, true);

    // this layer will group all the nearby circles that are added or removed from it when the portals are added or removed
    nearbyGroupLayer = L.layerGroup();

    thisPlugin.addAllMarkers();

    const toolbox = document.getElementById('toolbox');

    const buttonTHM = document.createElement('a');
    buttonTHM.textContent = 'THM Actions';
    buttonTHM.title = 'Actions on THM data';
    buttonTHM.addEventListener('click', thisPlugin.thmActionsDialog);
    toolbox.appendChild(buttonTHM);

    const buttonGrid = document.createElement('a');
    buttonGrid.textContent = 'THM Settings';
    buttonGrid.title = 'Settings for S2 & THM';
    buttonGrid.addEventListener('click', e => {
      if (thisPlugin.isSmart)
        window.show('map');
      showS2Dialog();
    });
    toolbox.appendChild(buttonGrid);

    map.on('zoomend', zoomListener);
    zoomListener();
    map.on('moveend', updateMapGrid);
    updateMapGrid();

    // add ids to the links that we want to be able to hide
    const links = document.querySelectorAll('#toolbox > a');
    links.forEach(a => {
      const text = a.textContent;
      if (text == 'Region scores') {
        a.id = 'scoresLink';
      }
      if (text == 'Artifacts') {
        a.id = 'artifactLink';
      }
    });

  };

  function createCounter(title, type, callback) {
    const div = document.createElement('div');
    div.style.display = 'none';
    const sTitle = document.createElement('span');
    sTitle.textContent = title;
    const counter = document.createElement('a');
    counter.id = 'THMCounter-' + type;
    counter.addEventListener('click', function (e) {
      callback(counter.THMData);
      return false;
    });
    div.appendChild(sTitle);
    div.appendChild(counter);
    return div;
  }

  function updateCounter(type, data) {
    const counter = document.querySelector('#THMCounter-' + type);
    counter.THMData = data;
    counter.textContent = data.length;
    counter.parentNode.style.display = data.length > 0 ? '' : 'none';

    // Adjust visibility of the pane to avoid the small gap due to padding
    const pane = counter.parentNode.parentNode;
    if (data.length > 0) {
      pane.style.display = '';
      return;
    }
    let node = pane.firstElementChild;
    while (node) {
      const rowData = node.lastElementChild.THMData;
      if (rowData && rowData.length > 0) {
        pane.style.display = '';
        return;
      }
      node = node.nextElementSibling;
    }
    pane.style.display = 'none';
  }

  // PLUGIN END //////////////////////////////////////////////////////////

  setup.info = plugin_info; //add the script info data to the function as a property
  // if IITC has already booted, immediately run the 'setup' function
  if (window.iitcLoaded) {
    setup();
  } else {
    if (!window.bootPlugins) {
      window.bootPlugins = [];
    }
    window.bootPlugins.push(setup);
  }
}

(function () {
  const plugin_info = {};
  if (typeof GM_info !== 'undefined' && GM_info && GM_info.script) {
    plugin_info.script = {
      version: GM_info.script.version,
      name: GM_info.script.name,
      description: GM_info.script.description
    };
  }

  // Greasemonkey. It will be quite hard to debug
  if (typeof unsafeWindow != 'undefined' || typeof GM_info == 'undefined' || GM_info.scriptHandler != 'Tampermonkey') {
    // inject code into site context
    const script = document.createElement('script');
    script.appendChild(document.createTextNode('(' + wrapperS2 + ')();'));
    script.appendChild(document.createTextNode('(' + wrapperPlugin + ')(' + JSON.stringify(plugin_info) + ');'));
    (document.body || document.head || document.documentElement).appendChild(script);
  } else {
    // Tampermonkey, run code directly
    wrapperS2();
    wrapperPlugin(plugin_info);
  }
})();
