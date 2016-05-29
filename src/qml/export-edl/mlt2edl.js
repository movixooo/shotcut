/*
 * MltXmlParser class Copyright (c) 2016 Meltytech, LLC
 * Author: Dan Dennedy <dan@dennedy.org>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

var xmldoc;
var timecode;

if (typeof module !== 'undefined' && module.exports) {
    // We're being used in a Node-like environment
    xmldoc = require('xmldoc');
    timecode = require('timecode').Timecode;
} else {
    // assume it's attached through qml-browserify
    xmldoc = modules.xmldoc;
    if (!xmldoc)
        throw new Error("Expected xmldoc to be defined. Make sure you're including xmldoc.js before this file.");
    timecode = modules.timecode.Timecode
    if (!timecode)
        throw new Error("Expected timecode to be defined. Make sure you're including timecode.js before this file.");
}

////////////////////////////////////////////////////////////////////////////////

function MltXmlParser(xmlString) {
    this.xmldoc = new xmldoc.XmlDocument(xmlString);
    this.projectMeta = this.xmldoc.childNamed('profile');
    this.framerate = parseFloat(this.projectMeta.attr.frame_rate_num) / parseFloat(this.projectMeta.attr.frame_rate_den);
}

MltXmlParser.prototype.prepadString = function (str, len, chr) {
    var padding = Array(len - String(str).length + 1).join(chr);
    return padding + str;
};

MltXmlParser.prototype.Timecode = function(value) {
    if (typeof value === 'string') {
        // Determine if this is a MLT "clock" time string.
        if (value.length === 12 && value[8] === '.') {
            // Convert the milliseconds portion to frame units.
            var ms = parseFloat(value.substring(9, 12));
            var fr = Math.round(ms / 1000 * this.framerate).toString();
            value = value.substring(0, 8) + ':' + this.prepadString(fr, 2, '0');
        } else if (value.indexOf(':') === -1) {
            value = parseInt(value);
        }
    }
    // Return a Timecode object.
    return timecode.init({
       'framerate': this.framerate,
       'timecode': value
    });
};

MltXmlParser.prototype.getPlaylists = function() {
    var playlistList = [];
    var playlists = this.xmldoc.childrenNamed('playlist');
    var self = this;
    playlists.forEach(function(p) {
        var eventList = [];
        var plDict = {};
        plDict.pid = p.attr.id;
        plDict.format = 'V';
        p.childrenNamed('property').forEach(function (fe) {
            if (fe.attr.name === 'shotcut:audio')
                plDict.format = 'A'
            else if (fe.attr.name === 'shotcut:video')
                // AA/V for Sony Vegas/Lightworks.
                plDict.format = 'AA/V';
        });
        p.children.forEach(function (event) {
            if ('length' in event.attr) {
                var out = self.Timecode(event.attr['length']);
                // MLTblacks are 1 frame longer than "out".
                out.subtract(self.Timecode(1));
                eventList.push({
                    'producer': 'black',
                    'inTime': self.Timecode(0).toString(),
                    'outTime': out.toString()
                });
            }
            if ('producer' in event.attr) {
                if (event.attr.producer.substring(0, 7) === 'tractor') {
                    // dissolve or wipe transition
                    self.xmldoc.childrenNamed('tractor').forEach(function (tractor) {
                        if (tractor.attr.id === event.attr.producer) {
                            var count = 0;
                            tractor.childrenNamed('track').forEach(function (track) {
                                if (!count) {
                                    eventList.push({
                                        'producer': track.attr.producer,
                                        'inTime': track.attr.in,
                                        'outTime': track.attr.out,
                                        'transition': 'C'
                                    });
                                } else {
                                    var length = self.Timecode(track.attr.out);
                                    length.subtract(self.Timecode(track.attr.in));
                                    length.add(self.Timecode(1));
                                    eventList.push({
                                        'producer': track.attr.producer,
                                        'inTime': track.attr.in,
                                        'outTime': track.attr.out,
                                        'transition': 'D',
                                        'transitionLength': length.frame_count
                                    });
                                };
                                count += 1;
                            });
                        }
                    });
                } else if (event.attr.producer !== 'black') {
                    eventList.push({
                       'producer': event.attr.producer.replace(' ', '_'),
                       'inTime': event.attr.in,
                       'outTime': event.attr.out,
                       'transition': 'C' 
                    });
                }
            }
        });
        plDict.events = eventList;
        playlistList.push(plDict);
    });
    return playlistList;
};

MltXmlParser.prototype.getProducers = function() {
    var producerList = [];
    var producers = this.xmldoc.childrenNamed('producer');
    producers.forEach(function(p) {
        var pDict = {};
        pDict.pid = p.attr.id;
        pDict.inTime = p.attr.in;
        pDict.outTime = p.attr.out;
        p.childrenNamed('property').forEach(function(property){
            pDict[property.attr.name] = property.val;
        });
        producerList.push(pDict);
    });
    return producerList;
};

MltXmlParser.prototype.linkReferences = function() {
    var sourceLinks = {};
    this.getProducers().forEach(function(p){
        sourceLinks[p.pid] = p.resource;
    });
    return sourceLinks;
};

MltXmlParser.prototype.createEdl = function() {
    var sourceLinks = this.linkReferences();
    var EDLfile = '';
    var self = this;
    self.getPlaylists().forEach(function (playlist) {
        if (playlist.pid === 'main bin' || playlist.pid === 'background')
            return;
        var EdlEventCount = 1;
        var progIn = self.Timecode(0); //showtime tally
        var progOut = self.Timecode(0);
        var srcChannel = 'C'; // default channel/track assignment
        EDLfile += "\n === " + playlist.pid + " === \n\n";
        playlist.events.forEach(function(event) {
            var srcIn = self.Timecode(event.inTime);
            var srcOut = self.Timecode(event.outTime);
            var srcLen = self.Timecode(event.outTime); srcLen.subtract(srcIn);
            // increment program tally
            progOut.add(srcLen);
            var sourcePath = sourceLinks[event.producer];
            var sourceRef = sourcePath.split('/').pop();
            if (sourceRef !== 'black') {
                EDLfile += '* FROM CLIP NAME: ' + sourceRef + "\n";
                sourceRef = (sourceRef + '         ').substring(0, 8);
                if (event.transition[0] === 'D') {
                    EdlEventCount -= 1;
                }
                EDLfile += self.prepadString(EdlEventCount, 3, '0') + '  '; // edit counter
                EDLfile += sourceRef + ' '; // "reel number"
                EDLfile += self.prepadString(playlist.format, 4, ' ') + ' '; // channels
                EDLfile += self.prepadString(event.transition, 4, ' ') + ' '; // type of edit/transition
                if ('transitionLength' in event) {
                    EDLfile += self.prepadString(event.transitionLength, 3, '0') + ' ';
                } else {
                    EDLfile += '    ';
                }
                EDLfile += srcIn.toString() + ' ' + srcOut.toString() + ' ';
                EDLfile += progIn.toString() + ' ' + progOut.toString() + "\n";

                EdlEventCount += 1;
            }
            progIn.add(srcLen);
        });
    });
    return EDLfile;
};

////////////////////////////////////////////////////////////////////////////////
// Are we being used in a Node-like environment?
if (typeof module !== 'undefined' && module.exports)
    module.exports.MltXmlParser = MltXmlParser;