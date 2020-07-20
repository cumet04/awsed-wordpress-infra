# AWSいい感じWordpressインフラ
可能な限りAWSをフル活用したインフラを組んでみたもの。題材としてWordpressを利用。

できる限り実運用を想定しています。

**注意: この構成による実運用実績は無いため、思わぬ欠陥がある可能性は否定できません**

### 初期構築手順

#### 1. EC2のAMIの用意
1. 適当なssh可能なAmazonLinux2インスタンスを用意する
2. `playbook`ディレクトリより、上記インスタンスにplaybookを投入する
3. 完了したらAMIを取得する。AMI名は`wordpress`としておく（`cdk.ts`の`amiName`に準拠）
4. 取得完了したらインスタンスは削除しておく


#### 2. ACMでALB/Cloudfront用の証明書を用意
1. ACMで証明書を作成する
  - ALB（管理画面）, ALB（閲覧）, Cloudfront（閲覧）にそれぞれセットできればok
  - Cloudfront用はバージニアリージョンで発行
2. 作成した証明書のARNをそれぞれ環境変数に入れておく
  - FRONT_CERT_ARN（Cloudfront用）, ADMIN_CERT_ARN（管理画面用）, ALB_CERT_ARN（ALB用）


#### 3. CDKを投入する
1. `cdk.ts`に設定されているパラメータを確認しておく（少なくともLB用のドメイン名は要修正※）
2. `cdk`ディレクトリより`npm run deploy`でCDKスタックを投入する

この時点ではWordpressのコンテンツが存在しないためALBヘルスチェックがコケる

※Cloudfrontの転送先となる（つまり通常閲覧用の）ドメイン。管理画面用はここでは指定しない


#### 4-1. 作業用EC2にsshが通るようにする
この構成のEC2はプライベートサブネットに属しているため、インターネットや手元からファイルを送るには手元からscpする必要がある。(※)

そこで少々設定してEC2に手元からSSM SSHが通るようにする。

1. AWSコンソールから対象インスタンスに「接続」する
2. ec2-userの`~/.ssh/authorized_keys`に自分の公開鍵を入れる
3. `/etc/ssh/sshd_config`にて`UsePAM yes`のコメントアウトを外してreloadする（なければそのまま）
4. 手元からSSM経由でsshできるように設定しておく

※ EC2にバックアップ用のS3からの読み取り権限を付与し、AWSコンソールからファイルアップ -> EC2からawscliで取得、という方法もある。頻繁にファイルをやり取りする場合や転送するファイルが大きい場合（SSM SSHは巨大なデータ転送に弱い）にはこちらの方法でも。


#### 4-2. Wordpressのコンテンツを配置する
1. wordpressコンテンツおよびDBダンプ（あれば）を用意し、手元から上記インスタンスにscpで転送する
2. サーバにsshで入り、`/var/www/html`にコンテンツを展開する
3. 上記展開したコンテンツに対し`chown apache:apache`しておく
4. `wp-config.php`にDB情報を記載する(※1)（必要な情報はAWSコンソールのSecretManagerから参照する）
5. `wp-config.php`に`HTTP_X_FORWARDED_PROTO`用の設定を追加する
```
if($_SERVER['HTTP_X_FORWARDED_PROTO'] == 'https') {
  $_SERVER['HTTPS'] = 'on';
  $_ENV['HTTPS'] = 'on';
}
```
6. （既存からの移行の場合）DBダンプをRDSにリストアしておく
7. 4-1で実施したsshまわりの設定を戻しておく(※2)

この時点でALBのドメイン経由でWordpressコンテンツが確認できるはず（初期投入ならインストール画面になる）

※1 パスワード内の記号のエスケープに注意; https://www.javadrive.jp/php/string/index4.html

※2 普段のメンテなどの作業はAWSコンソールから実施する想定


#### 5. ドメインまわりの設定を行う
以下3点についてDNS設定を行う:

* Cloudfront（一般ユーザの閲覧用）
* ALB-1（Cloudfrontから受ける、一般ユーザの閲覧用。3. で指定したもの）
* ALB-2（管理画面アクセス用）

またAWSコンソールよりCloudfrontのDistributionを確認し、CNAMEsを設定しておく。

なおRoute53を使うのであればwebサイト全体の閲覧ヘルスチェックが設定できるはず。

#### 6. アラート通知用のSNSトピックのアクションを設定する
SNSに`infraAlarm`というトピックができているため、適切にサブスクリプションを設定する。
メールでもLambda->slackでもChatbotでも。


### TODO
* コンテンツ・DBバックアップをS3に取りたい
  - 深夜バッチ的なやつ。EFSのドキュメントルート・DBダンプをS3に置く
  - EC2にスクリプト配置＆[SSM & Lambdaで1台cron](https://qiita.com/cumet04/items/5888e037105e6ea5f6bc)すればできるはず
