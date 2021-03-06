var EventEmitter = require("eventemitter3"),
    IntervalTree = require("interval-tree"),
    Timex = require("timex");

module.exports = (function() {
  function Kinetophone(channels, totalDuration, options) {
    if (totalDuration === null || typeof totalDuration === "undefined") {
      throw new Error("You must specify a total duration");
    }

    EventEmitter.call(this);
    channels = channels || [];
    options = options || {};

    this._channels = {};
    this._activeTimingsPerChannel = {};
    this._totalDuration = totalDuration;

    channels.forEach(this.addChannel.bind(this));

    this._playing = false;
    this._timer = new Timex();
    this._timer.register(this._timerCallback.bind(this));
    this._lastTimerCallback = null;

    this._tickResolution = options.timeUpdateResolution || 33;
    if (options.tickImmediately) setTimeout(function() { this._timerCallback(0) }.bind(this));
  }

  Kinetophone.prototype = EventEmitter.prototype;

  Kinetophone.prototype.addChannel = function(channel) {
    var name = channel.name;

    if (this._channels[name]) {
      throw new Error("Duplicate channel name '" + name + "'");
    }

    var tree = new IntervalTree(this._totalDuration / 2),
        timings = channel.timings || [];

    this._channels[name] = {
      name: name,
      timings: timings,
      tree: tree
    };
    this._activeTimingsPerChannel[name] = [];

    timings.forEach(function(timing) {
      this._addTimingToTree(tree, timing);
    }.bind(this));
  };

  Kinetophone.prototype.addTiming = function(channelName, timing) {
    var channel = this._channels[channelName];

    if (!channel) {
      throw new Error("No such channel '" + channelName + "'");
    }

    var tree = channel.tree;
    this._addTimingToTree(tree, timing);
  };

  Kinetophone.prototype._addTimingToTree = function(tree, timing) {
    var end;
    if (typeof timing.end === "undefined" && typeof timing.duration === "undefined") {
      end = timing.start + 1;
    } else if (typeof timing.end === "undefined") {
      end = timing.start + timing.duration;
    } else if (typeof timing.duration === "undefined") {
      end = timing.end;
    } else {
      throw new Error("Cannot specify both 'end' and 'duration'");
    }

    tree.add([timing.start, end, { start: timing.start, end: end, data: timing }]);
  };

  Kinetophone.prototype.totalDuration = function(duration) {
    if (typeof duration === "undefined") {
      return this._totalDuration;
    } else if (duration === null) {
      throw new Error("You must specify a non-null total duration");
    } else {
      this._totalDuration = duration;

      Object.keys(this._channels).forEach(function(channelName) {
        var channel = this._channels[channelName];
        delete this._channels[channelName];

        this.addChannel({
          name: channel.name,
          timings: channel.timings
        });
      }.bind(this));
    }
  };

  Kinetophone.prototype._timerCallback = function(time) {
    if (this._lastTimerCallback === null) {
      this.emit("timeupdate", time);
      this._lastTimerCallback = time;
      this._resolveTimings(0, time);
    } else if (time - this._lastTimerCallback >= this._tickResolution) {
      this.emit("timeupdate", time);
      this._resolveTimings(this._lastTimerCallback + 1, time);
      this._lastTimerCallback = time;
    }

    if (time > this._totalDuration) {
      this.pause();
      this._timer.set(0);
      this._lastTimerCallback = null;
      this._clearAllTimings();
      this.emit("end");
    }
  };

  Kinetophone.prototype.pause = function() {
    if (!this._playing) return;

    this._playing = false;
    this.emit("pause");
    this._timer.pause();
  };

  Kinetophone.prototype.play = function() {
    if (this._playing) return;

    if (this._timer.currentTime >= this._totalDuration) {
      this._timer.set(0);
      this._lastTimerCallback = null;
      this._clearAllTimings();
    }

    this._playing = true;
    this.emit("play");
    this._timer.start();
  };

  Kinetophone.prototype.playing = function() {
    return this._playing;
  };

  Kinetophone.prototype.currentTime = function(newTime) {
    if (newTime === undefined) {
      return this._timer.currentTime;
    } else {
      this._lastTimerCallback = newTime;
      if (newTime < 0) newTime = 0;
      if (newTime > this._totalDuration) newTime = this._totalDuration;
      this.emit("seeking", newTime);
      this._timer.set(newTime);
      this.emit("timeupdate", newTime);
      this._resolveTimings(newTime, newTime);
      this.emit("seek", newTime);
    }
  };

  Kinetophone.prototype.playbackRate = function(rate) {
    if (rate === undefined) {
      return this._timer.getRate();
    } else {
      return this._timer.setRate(rate);
    }
  };

  Kinetophone.prototype._resolveTimings = function(lastTime, currentTime) {
    Object.keys(this._channels).forEach(function(chan) {
      this._resolveTimingsForChannel(chan, lastTime, currentTime);
    }.bind(this));
  };

  Kinetophone.prototype._clearAllTimings = function() {
    Object.keys(this._channels).forEach(function(chan) {
      this._clearAllTimingsForChannel(chan);
    }.bind(this));
  };

  Kinetophone.prototype._resolveTimingsForChannel = function(channel, lastTime, currentTime) {
    var timingsRef = this._activeTimingsPerChannel[channel];

    var timingsToRemove = [];
    var timingsToAdd = lastTime === currentTime ?
        this._channels[channel].tree.search(currentTime) :
        this._channels[channel].tree.search(lastTime, currentTime);

    timingsRef.forEach(function(timing, i) {
      if (currentTime < timing.start || currentTime >= timing.end) {
        var toEmit = { name: channel, start: timing.start, data: timing.data.data };
        if (typeof timing.data.data !== "undefined") toEmit.data = timing.data.data;
        if (typeof timing.data.end !== "undefined") toEmit.end = timing.data.end;
        if (typeof timing.data.duration !== "undefined") toEmit.duration = timing.data.duration;
        this.emit("exit", toEmit);
        this.emit("exit:" + channel, toEmit);
        // High to low so indexes don't change when we remove them later
        timingsToRemove.unshift(i);
      }
    }.bind(this));

    timingsToRemove.forEach(function(idx) {
      timingsRef.splice(idx, 1);
    });

    timingsToAdd.forEach(function(timing) {
      timing = timing.data[2];
      if (currentTime >= timing.start && currentTime < timing.end && timingsRef.indexOf(timing) === -1) {
        var toEmit = timingFromRawData(channel, timing);
        this.emit("enter", toEmit);
        this.emit("enter:" + channel, toEmit);
        timingsRef.push(timing);
      }
    }.bind(this));
  };

  Kinetophone.prototype._clearAllTimingsForChannel = function(channel) {
    this._activeTimingsPerChannel[channel].forEach(function(timing) {
      var toEmit = timingFromRawData(channel, timing);
      this.emit("exit", toEmit);
      this.emit("exit:" + channel, toEmit);
    }.bind(this));

    this._activeTimingsPerChannel[channel] = [];
  };

  Kinetophone.prototype.getTimingsAt = function(time, channels) {
    var search = function(tree) { return tree.search(time); },
        filter = function(rawTiming) {
          rawTiming = rawTiming.data[2];
          return time >= rawTiming.start && time < rawTiming.end;
        };
    return this._findTimings(channels, filter, search);
  };

  Kinetophone.prototype.getTimingsBetween = function(start, end, channels) {
    var search = function(tree) { return tree.search(start, end); },
        filter = function(rawTiming) {
          rawTiming = rawTiming.data[2];
          return end !== rawTiming.end; // non-inclusive
        };
    return this._findTimings(channels, filter, search);
  };

  Kinetophone.prototype._findTimings = function(channels, filterFn, treeSearchFn) {
    channels = channels || Object.keys(this._channels);
    if (typeof channels === "string") channels = [channels];

    return channels.map(function(channel) {
      return {
        name: channel,
        timings: treeSearchFn(this._channels[channel].tree).filter(filterFn).map(function(rawTiming) {
          return timingFromRawData(channel, rawTiming.data[2]);
        })
      };
    }.bind(this)).reduce(function(acc, current) {
      acc[current.name] = current.timings;
      return acc;
    }, {});
  };

  function timingFromRawData(channel, timing) {
    var result = { name: channel, start: timing.data.start };
    if (typeof timing.data.data !== "undefined") result.data = timing.data.data;
    if (typeof timing.data.end !== "undefined") result.end = timing.data.end;
    if (typeof timing.data.duration !== "undefined") result.duration = timing.data.duration;
    return result;
  }

  return Kinetophone;
}());
