'use strict';

var app = angular.module('DashPlayer', ['ngFileSaver']);

app.controller('DashController', function($scope, FileSaver, Blob) {

    // $scope.url = "http://192.168.0.175/dashcontent/testvideo_24_modified.mpd";
    //$scope.url = "http://222.31.64.59/testvideo2/testvideo_24_modified.mpd";
    $scope.url = "http://192.168.0.104/finalseq/lvxing/lvxing_modified.mpd";
    $scope.video = document.querySelector("#videoPlayer");
    $scope.player = dashjs.MediaPlayer().create();
    //by huaying
    //  $scope.player.enablePerceptualContentAwareThroughputABR(true);
    //  $scope.player.enableLocalPerceptualContentAwareThroughputABR(true,1);
					//$scope.player.enableBufferOccupancyABR(true);
    $scope.player.enableMdpPerceptualContentAwareRule(true);

    $scope.player.initialize($scope.video, $scope.url, true);

    $scope.player.on(dashjs.MediaPlayer.events.PERIOD_SWITCH_COMPLETED, function (e) {
        $scope.streamInfo = e.toStreamInfo;
    }, $scope);

    $scope.DownloadMetrics_BufferLevel = function (type) {
        var metrics = $scope.player.getMetricsFor(type);
        var text = '';

        var startTime;

        for (var i = 0; i < metrics['BufferLevel'].length; i ++)
        {
            if (i == 0)
                startTime = metrics['BufferLevel'][i]['t'].getTime();
            var curTime = metrics['BufferLevel'][i]['t'].getTime() - startTime;
            text += curTime + ',' + metrics['BufferLevel'][i]['level']/1000 + '\r\n';
        }
        var data = new Blob([text], { type: 'text/plain;charset=utf-8' });
        FileSaver.saveAs(data, 'BufferLevel.csv');
    }

    $scope.DownloadMetrics_BitRate = function (type) {
        var periodIdx = $scope.streamInfo.index;
        var metrics = $scope.player.getMetricsFor(type);
        // var dashMetrics = $scope.player.getDashMetrics();
        var dashImportanceInfoArray = $scope.player.getImportanceInfoArray();

        var text = '';
        var startTime;

        for (var i = 0; i < metrics['SchedulingInfo'].length; i++)
        {
            var scheduleInfo = metrics['SchedulingInfo'][i];
            if (scheduleInfo.mediaType == type && scheduleInfo.state == 'executed' && scheduleInfo.type == 'MediaSegment')
            {
                if (text == '')
                {
                    startTime = scheduleInfo.t.getTime();
                }
                var qualityId = scheduleInfo.quality + 1;
                var segmentId = scheduleInfo.startTime/scheduleInfo.duration;
                var curImportance = 0;
                var curScene = '';
                if (dashImportanceInfoArray)
                {
                    curImportance = dashImportanceInfoArray[segmentId].importance;
                    curScene = dashImportanceInfoArray[segmentId].scene.substr(4);
                }
                // var bitRate = Math.round(dashMetrics.getBandwidthForRepresentation(qualityId.toString(), periodIdx) / 1000);
                var curTime = scheduleInfo.t.getTime() - startTime;
                text += segmentId + ','  + qualityId + ',' + curImportance + ',' + curScene + '\r\n';
            }
        }
        var data = new Blob([text], { type: 'text/plain;charset=utf-8' });
        FileSaver.saveAs(data, 'Bitrate.csv');
    }
});

