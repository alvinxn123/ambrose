/*
Copyright 2012 Twitter, Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

/**
 * This module defines the Graph view which generates horizontal DAG view of Workflow jobs.
 */
define(['lib/jquery', 'lib/underscore', 'lib/d3', '../core', './core', 'lib/bootstrap'], function(
  $, _, d3, Ambrose, View
) {

  // utility functions
  function isPseudo(node) { return node.pseudo; }
  function isReal(node) { return !(node.pseudo); }
  var progressToAngle = d3.interpolate(0, 2.0 * Math.PI);

  // generates an accessor for the given job state property
  function genJobStateAccessor(property) {
    return function(d) {
      return (d && d.data && d.data.mapReduceJobState && d.data.mapReduceJobState[property])
        ? d.data.mapReduceJobState[property]
        : null;
    };
  }

  // generates a getter for map / reduce progress property
  function genProgressValue(type) {
    return genJobStateAccessor(type + 'Progress');
  }

  // generates a [gs]etter for map / reduce progress angle property
  function genProgressAngle(type) {
    var property = type + 'ProgressAngle';
    return function(d, value) {
      if (value != null) d[property] = value;
      return d[property] || 0.0;
    };
  }

  // generate (map / reduce) progress (value / angle) getters
  var progress = {};
  ['map', 'reduce'].map(function(type) {
    progress[type] = {
      value: genProgressValue(type),
      angle: genProgressAngle(type),
    };
  });

  // Graph ctor
  var Graph = View.Graph = function(workflow, container, params) {
    return new View.Graph.fn.init(workflow, container, params);
  }

  /**
   * Graph prototype.
   */
  Graph.fn = Graph.prototype = {
    /**
     * Constructor.
     *
     * @param workflow the Workflow instance to bind to.
     * @param container the DOM element in which to render the view.
     * @param params extra parameters.
     */
    init: function(workflow, container, params) {
      var self = this;
      self.arcValueMax = 0;
      self.arcValueMin = 0;

      self.workflow = workflow;
      self.container = container = $(container);
      self.params = $.extend(true, {
        dimensions: {
          node: {
            radius: 8,
            progress: {
              map: { radius: 12 },
              reduce: { radius: 16 },
            },
            magnitude: {
              radius: {
                min: 16,
                max: 128,
              },
            },
          },
          edge: {
          },
        },
      }, View.Theme, params);
      self.resetView();

      // Let the upper and lower bound of the edges be 16px (radius) and 2px.
      self.edgeMaxWidth = self.params.dimensions.node.radius * 2;
      self.edgeMinWidth = 2;

      // shortcut to dimensions
      var dim = self.params.dimensions;

      // create arc generators
      self.arc = {
        progress: {
          map: d3.svg.arc()
            .innerRadius(0).outerRadius(dim.node.progress.map.radius)
            .startAngle(0).endAngle(function(a) { return a; }),
          reduce: d3.svg.arc()
            .innerRadius(0).outerRadius(dim.node.progress.reduce.radius)
            .startAngle(0).endAngle(function(a) { return a; }),
        },
      };

      // create scale for magnitude
      var magDomain = [10, 100, 1000, 10000];
      var magRadiusMin = dim.node.magnitude.radius.min;
      var magRadiusMax = dim.node.magnitude.radius.max;
      var magRadiusDelta = (magRadiusMax - magRadiusMin) / (magDomain.length + 1);
      var magRange = _.range(magRadiusMin, magRadiusMax, magRadiusDelta);
      self.magnitudeScale = d3.scale.threshold().domain(magDomain).range(magRange);

      // Ensure we resize appropriately
      $(window).resize(function() {
        // Remove the popover before resize, otherwise there will be more than 1 popover.
        $(".popover").remove();
        self.resetView();
        self.handleJobsLoaded();
      });

      // bind event workflow handlers
      workflow.on('jobsLoaded', function() {
        self.handleJobsLoaded();
      });
      workflow.on('jobStarted jobProgress jobComplete jobFailed', function(event, job) {
        self.handleJobsUpdated([job]);
      });
      workflow.on('jobSelected jobMouseOver', function(event, job, prev) {
        self.handleMouseInteraction($.grep([prev, job], function(j) { return j != null; }));
      });
    },

    resetView: function() {
      // initialize dimensions
      var container = this.container;
      var dim = this.dimensions = {};
      var width = dim.width = container.width();
      var height = dim.height = container.height();

      // create canvas and supporting d3 objects
      this.svg = d3.select(container.empty().get(0))
        .append('svg:svg')
        .attr('class', 'ambrose-view-graph')
        .attr('width', width)
        .attr('height', height);
      var xs = this.xs = d3.interpolate(0, width);
      var ys = this.ys = d3.interpolate(0, height);
      this.projection = function(d) { return [xs(d.x), ys(d.y)]; };
    },

    handleJobsLoaded: function() {
      this.arcValueMax = 0;
      this.arcValueMin = 0;

      // compute node x,y coords
      var graph = this.workflow.graph;
      var groups = graph.topologicalGroups;
      var groupCount = groups.length;
      var groupDelta = 1 / groupCount;
      var groupOffset = groupDelta / 2;
      $.each(groups, function(i, group) {
        var x = i * groupDelta + groupOffset;

        // determine number of real and pseudo nodes in group
        var realNodes = group.filter(isReal);
        var pseudoNodes = group.filter(isPseudo);
        var realNodeCount = realNodes.length;
        var pseudoNodeCount = pseudoNodes.length;
        var nodeCount = group.length;

        // count number of real and psuedo intervals between nodes
        var realIntervals = 1; // padding
        var pseudoIntervals = 0;
        for (var j = 0; j < group.length - 1; j++) {
          var n1 = group[j];
          var n2 = group[j+1];
          if (isReal(n1) || isReal(n2)) {
            realIntervals++;
          } else {
            pseudoIntervals++;
          }
        }

        // compute real and pseudo intervals
        var pseudoToRealIntervalRatio = 5.0;
        var pseudoIntervalDelta =
          1.0 / (
            (realIntervals * pseudoToRealIntervalRatio) + pseudoIntervals
          );
        var realIntervalDelta = pseudoIntervalDelta * pseudoToRealIntervalRatio;
        var offset = realIntervalDelta / 2.0;

        // assign vertical offsets to nodes; create edges
        $.each(group, function(j, node) {
          node.x = x;
          node.y = offset;
          // TODO(Andy Schlaikjer): Fix to support mixed ordering of real / pseudo nodes
          offset += isReal(node) ? realIntervalDelta : pseudoIntervalDelta;
          var edges = node.edges = [];
          $.each(node.parents || [], function(p, parent) {
            edges.push({ source: node, target: parent });
          });
        });
      });

      var graph = this.workflow.graph;
      var nodes = graph.nodes.concat(graph.pseudoNodes).sort(function(a, b) {
        return b.topologicalGroupIndex - a.topologicalGroupIndex;
      });
      var g = this.selectNodeGroups(nodes);
      this.removeNodeGroups(g);
      this.createNodeGroups(g);
      this.updateNodeGroups(g);

      // Create the popover title section based on the node.
      function getTitleEL(node) {
        var titleEL = '<span class="popoverTitle">Job id undefined</span>';

        if (node.__data__.data.mapReduceJobState) {
          var mrJobState = node.__data__.data.mapReduceJobState;
          titleEL = '<a target="_blank" href="'
          + mrJobState.trackingURL + '"> ' + mrJobState.jobId + ' </a>';
        }
        return titleEL;
      }

      // Create the popover body section based on the node.
      function getBodyEL(node) {
        if (!node.__data__.data) { return '<span class="popoverTitle">Job details unavailable</span>'; }
        var data = node.__data__.data;
        var bodyEL = '<div id="popoverBody"><ul>';

        if (data.status) {
          bodyEL += '<li><span class="popoverKey">Status:</span> ' + data.status + '</li>';
        }

        if (data.aliases) {
          bodyEL += '<li><span class="popoverKey">Aliases:</span> ' + data.aliases.join(', ')
          + '</li>';
        }

        if (data.features) {
          bodyEL += '<li><span class="popoverKey">Features:</span> ' + data.features.join(', ')
          + '</li>';
        }

        if (data.mapReduceJobState) {
          var mrJobState = data.mapReduceJobState;
          if (mrJobState.jobStartTime && mrJobState.jobLastUpdateTime) {
            var startTime = mrJobState.jobStartTime;
            var lastUpdateTime = mrJobState.jobLastUpdateTime;
            bodyEL += '<li><span class="popoverKey">Duration:</span> '
              + Ambrose.calculateElapsedTime(startTime, lastUpdateTime) + '</li>';
          }

          if (mrJobState.totalMappers) {
            bodyEL += '<li><span class="popoverKey">Mappers:</span> '
              + mrJobState.totalMappers + '</li>';
          }

          if (mrJobState.totalReducers) {
            bodyEL += '<li><span class="popoverKey">Reducers:</span> '
              + mrJobState.totalReducers + '</li>';
          }
        }

        return bodyEL + '</ul></div>';
      }

      // Display Popover.
      $(".node circle.anchor").each(function (i, node) {
        var titleEL = getTitleEL(node);
        var bodyEL = getBodyEL(node);

        $(this).popover({
          placement : function (context, source) {
            // Place the popover on the left if there is enough space.
            var position = $(source).position();

            if (position.left > 300) { return "left"; }
            return "right";
          },
          title : titleEL,
          content : bodyEL,
          container : 'body',
          html : 'true'
        });
      });

      $('.node circle.anchor').click(function(e) {
        // Hide all popover but the one just clicked.
        $('.node circle.anchor').not(this).popover('hide');
      });
    },

    handleJobsUpdated: function(jobs) {
      var nodes = jobs.map(function(j) { return j.node; });

      // Add all the pseudo node which are ancestors of the updated nodes also to the nodes list.
      // Recursive function which adds direct ancestor pseudo nodes to nodes array.
      var addPseudoNodes = function(node) {
        if (node == null || !node.pseudo) return;
        nodes.push(node);
        node.parents.forEach(addPseudoNodes);
      };

      // Initial nodes are not pseudo, but parents may be a pseudo node.
      nodes.slice(0).forEach(function(node) {
        node.parents.forEach(addPseudoNodes);
      });

      this.updateNodeGroups(this.selectNodeGroups(nodes));
      this.updateNodeGroups(this.selectPseudoNodeGroups(nodes));

      // Reset the to update the width of the previous edges.
      this.resetView();
      this.handleJobsLoaded();
    },

    handleMouseInteraction: function(jobs) {
      var nodes = jobs.map(function(j) { return j.node; });
      this.updateNodeGroupsFill(this.selectNodeGroups(nodes));
    },

    selectNodeGroups: function(nodes) {
      return this.svg.selectAll('g.node').data(nodes, function(node) { return node.id; });
    },

    selectPseudoNodeGroups: function(nodes) {
      return this.svg.selectAll('g.pseudo').data(nodes, function(node) { return node.id; });
    },

    removeNodeGroups: function(g) {
      g.exit().remove();
    },

    createNodeGroups: function(g) {
      var self = this;
      var xs = self.xs;
      var ys = self.ys;
      var projection = self.projection;
      var cx = function(d) { return xs(d.x); };
      var cy = function(d) { return ys(d.y); };
      var colors = self.params.colors;

      // create node group elements
      g = g.enter().append('svg:g')
        .attr('class', function(node) {
          return node.pseudo ? 'pseudo' : 'node';
        });

      // create out-bound edges from each node
      g.each(function(node, i) {
        d3.select(this).selectAll('path.edge').data(node.edges).enter()
          .append('svg:path').attr('class', 'edge')
          .attr("stroke-width", "1px")
          .attr("stroke", colors.nodeEdgeDefault)
          .attr('d', function(edge, i) {
            var p0 = edge.source,
            p3 = edge.target,
            m = (p0.x + p3.x) / 2,
            p = [p0, {x: m, y: p0.y}, {x: m, y: p3.y}, p3],
            p = p.map(projection);
            return "M" + p[0] + "C" + p[1] + " " + p[2] + " " + p[3];
          });
      });

      // filter down to real nodes
      var real = g.filter(isReal);

      // create translucent circle depicting relative size of each node
      real.append('svg:circle')
        .attr('class', function(node) {
          return 'magnitude ' + node.id;
        })
        .attr('cx', cx)
        .attr('cy', cy);

      // create arcs depicting MR task completion
      var progress = real.append('svg:g')
        .attr('class', 'progress')
        .attr('transform', function(d) {
          return 'translate(' + xs(d.x) + ',' + ys(d.y) + ')';
        });
      progress.append('svg:path')
        .attr('class', 'progress reduce');
      progress.append('svg:path')
        .attr('class', 'progress map');

      // create smaller circle and bind event handlers
      real.append('svg:circle')
        .attr('class', 'anchor')
        .attr('cx', cx)
        .attr('cy', cy)
        .attr('r', self.params.dimensions.node.radius)
        .on('mouseover', function(node) { self.workflow.mouseOverJob(node.data); })
        .on('mouseout', function(node) { self.workflow.mouseOverJob(null); })
        .on('click', function(node) { self.workflow.selectJob(node.data); });
    },

    updateNodeGroups: function(g) {
      var self = this;
      var duration = 750;
      var colors = self.params.colors;

      function getArcTween(progress, arc) {
        return function(d) {
          var b = progress.angle(d);
          var e = progress.angle(d, progressToAngle(progress.value(d)));
          var i = d3.interpolate(b, e);
          return function(t) {
            return arc(i(t));
          };
        };
      }

      // Rescales the width of the edges based on the counter/metrics we want.
      function rescaleEdgesWidth(d, i) {
        if (self.arcValueMax == self.arcValueMin && self.arcValueMin != 0) {
          return self.edgeMinWidth + "px";
        } else if (d.target.data && d.target.data.metrics && d.target.data.metrics.hdfsBytesWritten) {
          var w = d.target.data.metrics.hdfsBytesWritten;
          return (self.edgeMinWidth + (self.edgeMaxWidth - self.edgeMinWidth) / (self.arcValueMax - self.arcValueMin)
            * (w - self.arcValueMin)) + "px";
          }
        return "1px";
      }

      function rescaleEdgesColor(d, i) {
        if (d.target.data && d.target.data.metrics && d.target.data.metrics.hdfsBytesWritten) {
          return colors.nodeEdgeScaled;
        }
        return colors.nodeEdgeDefault;
      }

      // initiate transition
      t = g.transition().duration(duration);

      // udpate node fills
      self.updateNodeGroupsFill(t);

      // update map, reduce progress arcs
      t.selectAll('g.node path.map').attrTween("d", getArcTween(progress.map, self.arc.progress.map));
      t.selectAll('g.node path.reduce').attrTween("d", getArcTween(progress.reduce, self.arc.progress.reduce));

      // update magnitude radius
      t.selectAll('g.node circle.magnitude')
        .attr('r', function(node) {
          var radius = 0;
          if (node && node.data && node.data.mapReduceJobState) {
            // compute current radius
            var jobState = node.data.mapReduceJobState;
            var totalTasks = jobState.totalMappers + jobState.totalReducers;
            radius = self.magnitudeScale(totalTasks);

            // fetch previous radius
            var circle = $(this);
            var radiusPrev = circle.attr('r') || 0;
            var radiusDelta = radius - radiusPrev;
            if (radiusDelta != 0) {
              // radius changed; remove all tics immediately
              var $group = circle.parent();
              $group.find('circle.tic').remove();
              var group = d3.select($group[0]);

              // add all tics
              var cx = circle.attr('cx');
              var cy = circle.attr('cy');
              var factor = totalTasks;
              while (factor >= 10) {
                var radiusTic = self.magnitudeScale(factor);
                var tic = group.insert('svg:circle', 'g.progress')
                  .attr('class', 'tic')
                  .attr('cx', cx).attr('cy', cy)
                  .attr('r', radiusTic);
                if (radiusTic > radiusPrev) {
                  // new tic; animate opacity
                  tic.attr('opacity', 0)
                    .transition().delay(duration).delay(500)
                    .attr('opacity', 1);
                }
                factor /= 10;
              }
            }
          }
          return radius;
        });

      // Find the current max and min for all the available hdfsBytesWritten value.
      g.each(function(node, i) {
        if (node.data.metrics && node.data.metrics.hdfsBytesWritten) {
          var written = node.data.metrics.hdfsBytesWritten;
          if (written != 0) {
            if (self.arcValueMax < written) {
              self.arcValueMax = written;
            }

            if (self.arcValueMin > written || self.arcValueMin == 0) {
              self.arcValueMin = written;
            }
          }
        }
      });

      // Update the stroke width based on the hdfsBytesWritten value.
      g.each(function(node, i) {
        d3.select(this).selectAll('path.edge').data(node.edges)
          .attr("stroke-width", function(d, i) {
            return rescaleEdgesWidth(d, i);
          })
          .attr("stroke", function(d, i) {
            return rescaleEdgesColor(d, i);
          })
      });
    },

    updateNodeGroupsFill: function(g) {
      var self = this;
      var colors = self.params.colors;

      function fill(node) {
        var job = node.data;
        var status = job.status || '';
        if (job.mouseover) return colors.mouseover;
        if (job.selected) return colors.selected;
        return colors[status.toLowerCase()] || colors.pending;
      }

      g.selectAll('g.node circle.anchor').attr('fill', fill);
    },
  };

  // bind prototype to ctor
  Graph.fn.init.prototype = Graph.fn;
  return Graph;
});
