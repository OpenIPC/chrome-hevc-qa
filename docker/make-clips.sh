#!/bin/bash
# Generate the synthetic test clips into the current directory (the bind
# mounted clips/). Four seconds each, testsrc2 pattern, keyframe every 2 s.
# Chrome has no software HEVC decoder, so the three HEVC clips only play when
# hardware decode works; h264_1080p is the control that plays either way.
set -e
gen() {  # name size fps codec pixfmt tag
    local out=$1.mp4
    [ -f "$out" ] && { echo "$out exists"; return; }
    ffmpeg -loglevel error -y -f lavfi -i "testsrc2=size=$2:rate=$3" -t 4 \
        -c:v "$4" -preset ultrafast -pix_fmt "$5" ${6:+-tag:v $6} \
        $( [ "$4" = libx265 ] && echo -x265-params log-level=error ) "$out"
    echo "$out: $(ffprobe -v error -select_streams v -show_entries stream=codec_name,profile,width,height,pix_fmt -of csv=p=0 "$out")"
}
gen hevc_1080p  1920x1080 30 libx265 yuv420p     hvc1
gen hevc_4k     3840x2160 20 libx265 yuv420p     hvc1
gen hevc_main10 1920x1080 30 libx265 yuv420p10le hvc1
gen h264_1080p  1920x1080 30 libx264 yuv420p
