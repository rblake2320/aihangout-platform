package com.aihangout.installfixture;
public class MainActivity extends android.app.Activity {
 public void onCreate(android.os.Bundle state) {super.onCreate(state);android.widget.TextView v=new android.widget.TextView(this);v.setText("INSTALL FIXTURE ACTIVE - no permissions, no network, no stored data");v.setTextSize(24);setContentView(v);}
}