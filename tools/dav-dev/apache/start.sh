#!/bin/sh
set -e
htpasswd -bc /usr/local/apache2/conf/dav.passwd fc secret
mkdir -p /data/family-chat /data/other /usr/local/apache2/var
echo "not for the chat account" > /data/other/readme.txt
chown -R www-data:www-data /data /usr/local/apache2/var
exec httpd-foreground -f /dav/httpd.conf
