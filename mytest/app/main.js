'use strict';

var app = angular.module('DashPlayer', ['ngFileSaver']);

app.controller('DashController', function($scope, FileSaver, Blob) {

    $scope.url = "http://192.168.0.175:80/VODs/big_buck_bunny_128k_a_dash.mpd";

    $scope.video = document.querySelector("#videoPlayer");
    $scope.player = dashjs.MediaPlayer().create();
    //by huaying
    $scope.player.enablePerceptualContentAwareThroughputABR(true);

    $scope.player.initialize($scope.video, $scope.url, true);

    $scope.player.on(dashjs.MediaPlayer.events.PERIOD_SWITCH_COMPLETED, function (e) {
        $scope.streamInfo = e.toStreamInfo;
    }, $scope);

    $scope.DownloadMetrics_BufferLevel = function (type) {
        var metrics = $scope.player.getMetricsFor(type);
        var text = '';

        for (var i = 0; i < metrics['BufferLevel'].length; i ++)
        {
            text += metrics['BufferLevel'][i]['t'].getTime() + '\t' + metrics['BufferLevel'][i]['level'] + '\r\n';
        }
        var data = new Blob([text], { type: 'text/plain;charset=utf-8' });
        FileSaver.saveAs(data, 'BufferLevel.txt');
    }

    $scope.DownloadMetrics_BitRate = function (type) {
        var periodIdx = $scope.streamInfo.index;
        var metrics = $scope.player.getMetricsFor(type);
        var dashMetrics = $scope.player.getDashMetrics();

        var text = '';

        for (var i = 0; i < metrics['RepSwitchList'].length; i ++)
        {
            var repSwitch = metrics['RepSwitchList'][i];
            var bitrate = Math.round(dashMetrics.getBandwidthForRepresentation(repSwitch.to, periodIdx) / 1000);

            text += metrics['RepSwitchList'][i]['t'].getTime() + '\t' + bitrate + '\r\n';
        }
        var data = new Blob([text], { type: 'text/plain;charset=utf-8' });
        FileSaver.saveAs(data, 'Bitrate.txt');
    }
});

